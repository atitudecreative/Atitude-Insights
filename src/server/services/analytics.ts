import { sql, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/types";
import { hasGlobalRead } from "@/server/auth/types";
import { compare, costPerResult, cpc, cpm, ctr, engagement, metric, sumNullable, toMetric, type Change, type MetricValue } from "@/lib/metrics";
import { bucketFor, bucketKey, enumerateBuckets, previousPeriod, todayIso, type Bucket } from "@/lib/period";
import { asUser, isUuid } from "./context";
import type { DataMode } from "./mode";

/**
 * Agregações dos dashboards. TODAS as consultas rodam com o papel restrito
 * (RLS): um usuário nunca agrega dados de ministérios não autorizados,
 * mesmo que manipule filtros. Regras:
 *  - Alcance não é somado entre plataformas; dentro de uma fonte é rotulado
 *    como "não deduplicado" quando somado entre dias/entidades.
 *  - Métricas pagas usam somente o nível de campanha (evita dupla contagem
 *    com o nível de anúncio).
 *  - Publicações usam o snapshot mais recente (valores acumulados).
 */

export interface AnalyticsFilters {
  mode: DataMode;
  start: string;
  end: string;
  ministryId?: string | null;
  campaignId?: string | null;
  eventId?: string | null;
  channel?: string | null;
}

export interface Scope {
  ministryIds: string[];
  /** null = sem filtro de campanha/evento. */
  campaignIds: string[] | null;
  metaCampaignIds: string[] | null;
  postIds: string[] | null;
  eventId: string | null;
  channel: "meta_ads" | "instagram" | "facebook" | null;
}

const uuidArray = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
const dayStart = (iso: string) => new Date(`${iso}T00:00:00-03:00`);
const dayEnd = (iso: string) => new Date(`${iso}T23:59:59.999-03:00`);

export async function resolveScope(trx: Tx, f: AnalyticsFilters): Promise<Scope> {
  let mq = trx.selectFrom("app.ministries").select("id").where("is_demo", "=", f.mode === "demo");
  if (isUuid(f.ministryId)) mq = mq.where("id", "=", f.ministryId);
  const ministryIds = (await mq.execute()).map((m) => m.id);
  const channel = f.channel === "meta_ads" || f.channel === "instagram" || f.channel === "facebook" ? f.channel : null;
  let campaignIds: string[] | null = null;
  const eventId = isUuid(f.eventId) ? f.eventId : null;
  if (isUuid(f.campaignId)) campaignIds = [f.campaignId];
  else if (eventId) {
    campaignIds = (await trx.selectFrom("app.campaign_events").select("campaign_id").where("event_id", "=", eventId).execute()).map((r) => r.campaign_id);
  }
  let metaCampaignIds: string[] | null = null;
  let postIds: string[] | null = null;
  if (campaignIds) {
    metaCampaignIds = campaignIds.length ? (await trx.selectFrom("app.campaign_external_campaigns").select("external_campaign_id").where("campaign_id", "in", campaignIds).execute()).map((r) => r.external_campaign_id) : [];
    postIds = campaignIds.length ? (await trx.selectFrom("app.campaign_social_posts").select("social_post_id").where("campaign_id", "in", campaignIds).execute()).map((r) => r.social_post_id) : [];
  }
  return { ministryIds, campaignIds, metaCampaignIds, postIds, eventId, channel };
}

// ---------------------------------------------------------------------------
// Fontes e disponibilidade
// ---------------------------------------------------------------------------
export interface SourceStatus {
  connected: boolean;
  syncing: boolean;
  lastUpdate: string | null;
  accounts: number;
}

export async function sourceStatus(trx: Tx, scope: Scope): Promise<Record<"meta_ads" | "organic" | "asana", SourceStatus>> {
  const empty = (): SourceStatus => ({ connected: false, syncing: false, lastUpdate: null, accounts: 0 });
  const out = { meta_ads: empty(), organic: empty(), asana: empty() };
  if (!scope.ministryIds.length) return out;
  const rows = await sql<{ asset_type: string; n: number; last_synced: Date | null }>`
    select a.asset_type, count(distinct a.id)::int as n, max(a.last_synced_at) as last_synced
    from app.external_assets a
    join app.asset_ministry_mappings m on m.external_asset_id = a.id
    where m.ministry_id = any(${uuidArray(scope.ministryIds)}) and a.sync_enabled and a.removed_at is null
    group by a.asset_type`.execute(trx);
  for (const r of rows.rows) {
    const key = r.asset_type === "meta_ad_account" ? "meta_ads" : r.asset_type === "asana_project" ? "asana" : r.asset_type === "asana_workspace" ? null : "organic";
    if (!key) continue;
    out[key].connected = true;
    out[key].accounts += r.n;
    const ts = r.last_synced ? new Date(r.last_synced).toISOString() : null;
    if (ts && (!out[key].lastUpdate || ts > out[key].lastUpdate!)) out[key].lastUpdate = ts;
  }
  // Ativos sem vínculo direto, mas com dados já classificados para o escopo (ex.: contas compartilhadas).
  const classified = await sql<{ source: string; last: Date | null }>`
    select source, max(updated_at) as last from app.metric_observations
    where ministry_id = any(${uuidArray(scope.ministryIds)}) group by source`.execute(trx);
  for (const r of classified.rows) {
    const key = r.source === "meta_ads" ? "meta_ads" : r.source === "manual" ? null : "organic";
    if (!key) continue;
    out[key].connected = true;
    const ts = r.last ? new Date(r.last).toISOString() : null;
    if (ts && (!out[key].lastUpdate || ts > out[key].lastUpdate!)) out[key].lastUpdate = ts;
  }
  const asanaTasks = await sql<{ n: number; last: Date | null }>`
    select count(*)::int as n, max(updated_at) as last from app.tasks where source = 'asana' and ministry_id = any(${uuidArray(scope.ministryIds)})`.execute(trx);
  if ((asanaTasks.rows[0]?.n ?? 0) > 0) {
    out.asana.connected = true;
    out.asana.lastUpdate ??= asanaTasks.rows[0]?.last ? new Date(asanaTasks.rows[0].last).toISOString() : null;
  }
  const running = await trx.selectFrom("app.sync_jobs as j").innerJoin("app.connected_accounts as a", "a.id", "j.connected_account_id")
    .select(["a.provider", "j.job_type"]).where("j.status", "in", ["queued", "running"]).execute();
  for (const j of running) {
    if (j.job_type === "meta_ads") out.meta_ads.syncing = true;
    if (j.job_type === "meta_organic") out.organic.syncing = true;
    if (j.provider === "asana") out.asana.syncing = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operação
// ---------------------------------------------------------------------------
function taskScopeSql(scope: Scope) {
  if (scope.campaignIds) {
    const ids = scope.campaignIds.length ? scope.campaignIds : ["00000000-0000-0000-0000-000000000000"];
    return scope.eventId
      ? sql`(t.campaign_id = any(${uuidArray(ids)}) or t.event_id = ${scope.eventId}::uuid)`
      : sql`t.campaign_id = any(${uuidArray(ids)})`;
  }
  return sql`true`;
}

function deliverableScopeSql(scope: Scope) {
  if (scope.campaignIds) {
    const ids = scope.campaignIds.length ? scope.campaignIds : ["00000000-0000-0000-0000-000000000000"];
    return scope.eventId
      ? sql`(d.campaign_id = any(${uuidArray(ids)}) or d.event_id = ${scope.eventId}::uuid)`
      : sql`d.campaign_id = any(${uuidArray(ids)})`;
  }
  return sql`true`;
}

export async function operationalKpis(trx: Tx, scope: Scope, start: string, end: string) {
  const today = todayIso();
  const prev = previousPeriod({ start, end });
  const ids = uuidArray(scope.ministryIds.length ? scope.ministryIds : ["00000000-0000-0000-0000-000000000000"]);
  const t = await sql<{ done: number; done_prev: number; open: number; overdue: number; total: number }>`
    select
      count(*) filter (where completed and completed_at between ${dayStart(start)} and ${dayEnd(end)})::int as done,
      count(*) filter (where completed and completed_at between ${dayStart(prev.start)} and ${dayEnd(prev.end)})::int as done_prev,
      count(*) filter (where not completed)::int as open,
      count(*) filter (where not completed and due_on < ${today}::date)::int as overdue,
      count(*)::int as total
    from app.tasks t where t.ministry_id = any(${ids}) and t.removed_in_source_at is null and ${taskScopeSql(scope)}`.execute(trx);
  const d = await sql<{ produced: number; produced_prev: number }>`
    select
      count(*) filter (where status in ('approved','delivered') and coalesce(delivered_at, approved_at, created_at) between ${dayStart(start)} and ${dayEnd(end)})::int as produced,
      count(*) filter (where status in ('approved','delivered') and coalesce(delivered_at, approved_at, created_at) between ${dayStart(prev.start)} and ${dayEnd(prev.end)})::int as produced_prev
    from app.deliverables d where d.ministry_id = any(${ids}) and ${deliverableScopeSql(scope)}`.execute(trx);
  const campaignFilter = scope.campaignIds ? sql`and c.id = any(${uuidArray(scope.campaignIds.length ? scope.campaignIds : ["00000000-0000-0000-0000-000000000000"])})` : sql``;
  const c = await sql<{ active: number }>`
    select count(*)::int as active from app.campaigns c
    where c.ministry_id = any(${ids}) and c.status = 'active' ${campaignFilter}`.execute(trx);
  const eventFilter = scope.eventId ? sql`and e.id = ${scope.eventId}::uuid` : sql``;
  const e = await sql<{ ongoing: number }>`
    select count(*)::int as ongoing from app.events e
    where e.ministry_id = any(${ids}) and e.status <> 'cancelled' and e.archived_at is null ${eventFilter}
      and coalesce(e.promotion_start::timestamptz, e.starts_at) <= now()
      and coalesce(e.ends_at, e.starts_at + interval '6 hours') >= now()`.execute(trx);
  const served = await sql<{ n: number }>`
    select count(distinct ministry_id)::int as n from (
      select t.ministry_id from app.tasks t where t.ministry_id = any(${ids}) and t.completed and t.completed_at between ${dayStart(start)} and ${dayEnd(end)} and ${taskScopeSql(scope)}
      union
      select d.ministry_id from app.deliverables d where d.ministry_id = any(${ids}) and d.status in ('approved','delivered')
        and coalesce(d.delivered_at, d.approved_at, d.created_at) between ${dayStart(start)} and ${dayEnd(end)} and ${deliverableScopeSql(scope)}
    ) s`.execute(trx);
  const tr = t.rows[0]!;
  const dr = d.rows[0]!;
  return {
    tasksCompleted: tr.done, tasksCompletedChange: compare(tr.done, tr.done_prev),
    tasksOpen: tr.open, tasksOverdue: tr.overdue, tasksTotal: tr.total,
    deliverablesProduced: dr.produced, deliverablesChange: compare(dr.produced, dr.produced_prev),
    activeCampaigns: c.rows[0]!.active, ongoingEvents: e.rows[0]!.ongoing, ministriesServed: served.rows[0]!.n,
  };
}

export async function upcomingDeliveries(trx: Tx, scope: Scope, days = 14) {
  if (!scope.ministryIds.length) return [];
  const today = todayIso();
  const res = await sql<{ id: string; kind: string; title: string; due: string; ministry_name: string; href_id: string; overdue: boolean }>`
    select * from (
      select t.id, 'task' as kind, t.name as title, t.due_on::text as due, m.name as ministry_name, t.id as href_id, t.due_on < ${today}::date as overdue
      from app.tasks t join app.ministries m on m.id = t.ministry_id
      where t.ministry_id = any(${uuidArray(scope.ministryIds)}) and not t.completed and t.removed_in_source_at is null and t.due_on is not null
        and t.due_on <= (${today}::date + ${days}::int) and ${taskScopeSql(scope)}
      union all
      select d.id, 'deliverable', d.title, d.due_date::text, m.name, d.id, d.due_date < ${today}::date
      from app.deliverables d join app.ministries m on m.id = d.ministry_id
      where d.ministry_id = any(${uuidArray(scope.ministryIds)}) and d.status not in ('approved','delivered','cancelled') and d.due_date is not null
        and d.due_date <= (${today}::date + ${days}::int) and ${deliverableScopeSql(scope)}
    ) x order by due asc limit 8`.execute(trx);
  return res.rows;
}

export async function taskStatusDistribution(trx: Tx, scope: Scope) {
  if (!scope.ministryIds.length) return [];
  const today = todayIso();
  const r = await sql<{ completed: number; overdue: number; open: number }>`
    select count(*) filter (where completed)::int as completed,
           count(*) filter (where not completed and due_on < ${today}::date)::int as overdue,
           count(*) filter (where not completed and (due_on is null or due_on >= ${today}::date))::int as open
    from app.tasks t where t.ministry_id = any(${uuidArray(scope.ministryIds)}) and t.removed_in_source_at is null and ${taskScopeSql(scope)}`.execute(trx);
  const row = r.rows[0]!;
  return [
    { label: "Concluídas", value: row.completed, color: 2 },
    { label: "Em andamento", value: row.open, color: 0 },
    { label: "Atrasadas", value: row.overdue, color: 1 },
  ].filter((x) => x.value > 0);
}

// ---------------------------------------------------------------------------
// Comunicação — pago (Meta Ads)
// ---------------------------------------------------------------------------
type PaidTotals = Record<"spend" | "impressions" | "reach" | "clicks" | "link_clicks" | "video_views" | "results" | "conversions" | "conversion_value", number | null>;

function paidEntitySql(scope: Scope) {
  if (scope.metaCampaignIds) {
    return sql`and o.entity_id = any(${uuidArray(scope.metaCampaignIds.length ? scope.metaCampaignIds : ["00000000-0000-0000-0000-000000000000"])})`;
  }
  return sql``;
}

export async function paidTotals(trx: Tx, scope: Scope, start: string, end: string): Promise<{ totals: PaidTotals; currency: string | null; lastUpdate: string | null }> {
  const totals: PaidTotals = { spend: null, impressions: null, reach: null, clicks: null, link_clicks: null, video_views: null, results: null, conversions: null, conversion_value: null };
  if (!scope.ministryIds.length || (scope.channel && scope.channel !== "meta_ads")) return { totals, currency: null, lastUpdate: null };
  const r = await sql<{ metric_key: string; v: number; currency: string | null; last: Date }>`
    select o.metric_key, sum(o.value)::float8 as v, max(o.currency) as currency, max(o.updated_at) as last
    from app.metric_observations o
    where o.source = 'meta_ads' and o.entity_type = 'meta_campaign' and o.granularity = 'day'
      and o.ministry_id = any(${uuidArray(scope.ministryIds)}) and o.period_start between ${start}::date and ${end}::date ${paidEntitySql(scope)}
    group by o.metric_key`.execute(trx);
  let currency: string | null = null;
  let last: string | null = null;
  for (const row of r.rows) {
    if (row.metric_key in totals) totals[row.metric_key as keyof PaidTotals] = row.v;
    currency ??= row.currency;
    const ts = new Date(row.last).toISOString();
    if (!last || ts > last) last = ts;
  }
  return { totals, currency, lastUpdate: last };
}

export function derivePaid(t: PaidTotals) {
  return {
    ctr: ctr(t.clicks, t.impressions),
    cpc: cpc(t.spend, t.clicks),
    cpm: cpm(t.spend, t.impressions),
    costPerResult: costPerResult(t.spend, t.results),
  };
}

// ---------------------------------------------------------------------------
// Comunicação — orgânico (publicações, snapshot mais recente)
// ---------------------------------------------------------------------------
export type OrganicTotals = Record<"reach" | "views" | "likes" | "comments" | "shares" | "saves" | "total_interactions", number | null> & { posts: number };

function postScopeSql(scope: Scope) {
  const parts = [sql`p.ministry_id = any(${uuidArray(scope.ministryIds)})`];
  if (scope.postIds) parts.push(sql`p.id = any(${uuidArray(scope.postIds.length ? scope.postIds : ["00000000-0000-0000-0000-000000000000"])})`);
  if (scope.channel === "instagram" || scope.channel === "facebook") parts.push(sql`p.platform = ${scope.channel}`);
  return sql.join(parts, sql` and `);
}

export async function organicTotals(trx: Tx, scope: Scope, start: string, end: string): Promise<{ byPlatform: Record<string, OrganicTotals>; lastUpdate: string | null }> {
  const byPlatform: Record<string, OrganicTotals> = {};
  if (!scope.ministryIds.length || scope.channel === "meta_ads") return { byPlatform, lastUpdate: null };
  const r = await sql<{ platform: string; metric_key: string | null; v: number | null; posts: number; last: Date | null }>`
    with posts as (
      select p.id, p.platform from app.social_posts p
      where ${postScopeSql(scope)} and p.published_at between ${dayStart(start)} and ${dayEnd(end)} and p.removed_in_source_at is null
    ), latest as (
      select distinct on (o.entity_id, o.metric_key) o.entity_id, o.metric_key, o.value, o.updated_at
      from app.metric_observations o join posts on posts.id = o.entity_id
      where o.entity_type = 'social_post' and o.granularity = 'lifetime'
      order by o.entity_id, o.metric_key, o.period_end desc
    )
    select posts.platform, l.metric_key, sum(l.value)::float8 as v, count(distinct posts.id)::int as posts, max(l.updated_at) as last
    from posts left join latest l on l.entity_id = posts.id
    group by posts.platform, l.metric_key`.execute(trx);
  let last: string | null = null;
  for (const row of r.rows) {
    const p = (byPlatform[row.platform] ??= { reach: null, views: null, likes: null, comments: null, shares: null, saves: null, total_interactions: null, posts: 0 });
    p.posts = Math.max(p.posts, row.posts);
    if (row.metric_key && row.metric_key in p) (p as Record<string, number | null>)[row.metric_key] = row.v;
    if (row.last) {
      const ts = new Date(row.last).toISOString();
      if (!last || ts > last) last = ts;
    }
  }
  // Contagem real de publicações por plataforma (inclusive sem métricas).
  const counts = await sql<{ platform: string; n: number }>`
    select p.platform, count(*)::int as n from app.social_posts p
    where ${postScopeSql(scope)} and p.published_at between ${dayStart(start)} and ${dayEnd(end)} and p.removed_in_source_at is null
    group by p.platform`.execute(trx);
  for (const c of counts.rows) {
    (byPlatform[c.platform] ??= { reach: null, views: null, likes: null, comments: null, shares: null, saves: null, total_interactions: null, posts: 0 }).posts = c.n;
  }
  return { byPlatform, lastUpdate: last };
}

export function organicEngagement(t: OrganicTotals | undefined): number | null {
  if (!t) return null;
  return t.total_interactions ?? engagement({ likes: t.likes, comments: t.comments, shares: t.shares, saves: t.saves });
}

export async function topPosts(trx: Tx, scope: Scope, start: string, end: string, limit = 5) {
  if (!scope.ministryIds.length || scope.channel === "meta_ads") return [];
  const r = await sql<{ id: string; platform: string; caption: string | null; permalink: string | null; thumbnail_url: string | null; published_at: Date; media_type: string | null; ministry_name: string; metrics: Record<string, number> }>`
    with posts as (
      select p.id, p.platform, p.caption, p.permalink, p.thumbnail_url, p.published_at, p.media_type, m.name as ministry_name
      from app.social_posts p join app.ministries m on m.id = p.ministry_id
      where ${postScopeSql(scope)} and p.published_at between ${dayStart(start)} and ${dayEnd(end)} and p.removed_in_source_at is null
    ), latest as (
      select distinct on (o.entity_id, o.metric_key) o.entity_id, o.metric_key, o.value
      from app.metric_observations o join posts on posts.id = o.entity_id
      where o.entity_type = 'social_post' and o.granularity = 'lifetime'
      order by o.entity_id, o.metric_key, o.period_end desc
    )
    select posts.*, coalesce(jsonb_object_agg(l.metric_key, l.value) filter (where l.metric_key is not null), '{}'::jsonb) as metrics
    from posts left join latest l on l.entity_id = posts.id
    group by posts.id, posts.platform, posts.caption, posts.permalink, posts.thumbnail_url, posts.published_at, posts.media_type, posts.ministry_name`.execute(trx);
  const score = (m: Record<string, number>) => m.total_interactions ?? engagement({ likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves }) ?? -1;
  return r.rows.map((p) => ({ ...p, engagement: score(p.metrics) < 0 ? null : score(p.metrics) }))
    .sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Séries temporais
// ---------------------------------------------------------------------------
export async function timeSeries(trx: Tx, scope: Scope, start: string, end: string) {
  const bucket: Bucket = bucketFor({ start, end });
  const keys = enumerateBuckets({ start, end }, bucket);
  const rows = new Map(keys.map((k) => [k, { date: k, impressions: null as number | null, clicks: null as number | null, spend: null as number | null, organic_views: null as number | null, organic_interactions: null as number | null, tasks_done: 0 }]));
  if (!scope.ministryIds.length) return { bucket, rows: [...rows.values()] };
  const ids = uuidArray(scope.ministryIds);
  if (!scope.channel || scope.channel === "meta_ads") {
    const paid = await sql<{ d: string; metric_key: string; v: number }>`
      select o.period_start::text as d, o.metric_key, sum(o.value)::float8 as v from app.metric_observations o
      where o.source = 'meta_ads' and o.entity_type = 'meta_campaign' and o.granularity = 'day' and o.metric_key in ('impressions','clicks','spend')
        and o.ministry_id = any(${ids}) and o.period_start between ${start}::date and ${end}::date ${paidEntitySql(scope)}
      group by 1, 2`.execute(trx);
    for (const p of paid.rows) {
      const row = rows.get(bucketKey(p.d, bucket));
      if (!row) continue;
      const k = p.metric_key as "impressions" | "clicks" | "spend";
      row[k] = (row[k] ?? 0) + p.v;
    }
  }
  if (scope.channel !== "meta_ads") {
    const organic = await sql<{ d: string; metric_key: string; v: number }>`
      with posts as (
        select p.id, (p.published_at at time zone 'America/Sao_Paulo')::date as d from app.social_posts p
        where ${postScopeSql(scope)} and p.published_at between ${dayStart(start)} and ${dayEnd(end)} and p.removed_in_source_at is null
      ), latest as (
        select distinct on (o.entity_id, o.metric_key) o.entity_id, o.metric_key, o.value from app.metric_observations o join posts on posts.id = o.entity_id
        where o.entity_type = 'social_post' and o.granularity = 'lifetime' and o.metric_key in ('views','total_interactions','likes','comments','shares','saves')
        order by o.entity_id, o.metric_key, o.period_end desc
      )
      select posts.d::text as d, l.metric_key, sum(l.value)::float8 as v from posts join latest l on l.entity_id = posts.id group by 1, 2`.execute(trx);
    const interactionsByDay = new Map<string, { ti: number | null; parts: number | null }>();
    for (const o of organic.rows) {
      const row = rows.get(bucketKey(o.d, bucket));
      if (!row) continue;
      if (o.metric_key === "views") row.organic_views = (row.organic_views ?? 0) + o.v;
      else {
        const cur = interactionsByDay.get(o.d) ?? { ti: null, parts: null };
        if (o.metric_key === "total_interactions") cur.ti = (cur.ti ?? 0) + o.v;
        else cur.parts = (cur.parts ?? 0) + o.v;
        interactionsByDay.set(o.d, cur);
      }
    }
    for (const [d, v] of interactionsByDay) {
      const row = rows.get(bucketKey(d, bucket));
      if (row) row.organic_interactions = (row.organic_interactions ?? 0) + (v.ti ?? v.parts ?? 0);
    }
  }
  const tasks = await sql<{ d: string; n: number }>`
    select (t.completed_at at time zone 'America/Sao_Paulo')::date::text as d, count(*)::int as n from app.tasks t
    where t.ministry_id = any(${ids}) and t.completed and t.completed_at between ${dayStart(start)} and ${dayEnd(end)} and ${taskScopeSql(scope)}
    group by 1`.execute(trx);
  for (const t of tasks.rows) {
    const row = rows.get(bucketKey(t.d, bucket));
    if (row) row.tasks_done += t.n;
  }
  return { bucket, rows: [...rows.values()] };
}

// ---------------------------------------------------------------------------
// Por ministério e por campanha
// ---------------------------------------------------------------------------
export async function performanceByMinistry(trx: Tx, scope: Scope, start: string, end: string) {
  if (!scope.ministryIds.length) return [];
  const ids = uuidArray(scope.ministryIds);
  const r = await sql<{ id: string; name: string; slug: string; tasks_done: number; deliverables: number; active_campaigns: number; impressions: number | null; spend: number | null; organic_posts: number }>`
    select m.id, m.name, m.slug,
      (select count(*)::int from app.tasks t where t.ministry_id = m.id and t.completed and t.completed_at between ${dayStart(start)} and ${dayEnd(end)}) as tasks_done,
      (select count(*)::int from app.deliverables d where d.ministry_id = m.id and d.status in ('approved','delivered') and coalesce(d.delivered_at, d.approved_at, d.created_at) between ${dayStart(start)} and ${dayEnd(end)}) as deliverables,
      (select count(*)::int from app.campaigns c where c.ministry_id = m.id and c.status = 'active') as active_campaigns,
      (select sum(o.value)::float8 from app.metric_observations o where o.ministry_id = m.id and o.source = 'meta_ads' and o.entity_type = 'meta_campaign' and o.granularity = 'day' and o.metric_key = 'impressions' and o.period_start between ${start}::date and ${end}::date) as impressions,
      (select sum(o.value)::float8 from app.metric_observations o where o.ministry_id = m.id and o.source = 'meta_ads' and o.entity_type = 'meta_campaign' and o.granularity = 'day' and o.metric_key = 'spend' and o.period_start between ${start}::date and ${end}::date) as spend,
      (select count(*)::int from app.social_posts p where p.ministry_id = m.id and p.published_at between ${dayStart(start)} and ${dayEnd(end)}) as organic_posts
    from app.ministries m where m.id = any(${ids}) order by m.name`.execute(trx);
  return r.rows;
}

export async function investmentByCampaign(trx: Tx, scope: Scope, start: string, end: string, limit = 8) {
  if (!scope.ministryIds.length) return [];
  const ids = uuidArray(scope.ministryIds);
  const campaignFilter = scope.campaignIds ? sql`and c.id = any(${uuidArray(scope.campaignIds.length ? scope.campaignIds : ["00000000-0000-0000-0000-000000000000"])})` : sql``;
  const r = await sql<{ id: string; name: string; planned: number | null; manual: number | null; meta: number | null }>`
    select c.id, c.name,
      (select sum(i.amount)::float8 from app.investments i where i.campaign_id = c.id and i.kind = 'planned') as planned,
      (select sum(i.amount)::float8 from app.investments i where i.campaign_id = c.id and i.kind = 'realized'
         and (i.spent_on is null or i.spent_on between ${start}::date and ${end}::date)) as manual,
      (select sum(o.value)::float8 from app.metric_observations o
         join app.campaign_external_campaigns l on l.external_campaign_id = o.entity_id and l.campaign_id = c.id
         where o.source = 'meta_ads' and o.entity_type = 'meta_campaign' and o.granularity = 'day' and o.metric_key = 'spend'
           and o.period_start between ${start}::date and ${end}::date) as meta
    from app.campaigns c where c.ministry_id = any(${ids}) and c.status <> 'archived' ${campaignFilter}`.execute(trx);
  return r.rows
    .map((row) => ({ ...row, realized: sumNullable([row.manual, row.meta]) }))
    .filter((row) => row.realized != null || row.planned != null)
    .sort((a, b) => (b.realized ?? 0) - (a.realized ?? 0)).slice(0, limit);
}

export async function upcomingEvents(trx: Tx, scope: Scope, limit = 5) {
  if (!scope.ministryIds.length) return [];
  let q = trx.selectFrom("app.events as e").innerJoin("app.ministries as m", "m.id", "e.ministry_id")
    .select(["e.id", "e.name", "e.starts_at", "e.ends_at", "e.location", "e.status", "e.promotion_start", "m.name as ministry_name", "m.color as ministry_color"])
    .where("e.ministry_id", "in", scope.ministryIds).where("e.status", "<>", "cancelled").where("e.archived_at", "is", null)
    .where((eb) => eb.or([eb("e.starts_at", ">=", new Date()), eb("e.ends_at", ">=", new Date())]));
  if (scope.eventId) q = q.where("e.id", "=", scope.eventId);
  return q.orderBy("e.starts_at").limit(limit).execute();
}

export async function recentActivity(trx: Tx, scope: Scope, limit = 10) {
  if (!scope.ministryIds.length) return [];
  return trx.selectFrom("app.activity_logs as l").leftJoin("app.users as u", "u.id", "l.actor_user_id").leftJoin("app.ministries as m", "m.id", "l.ministry_id")
    .select(["l.id", "l.action", "l.summary", "l.entity_type", "l.entity_id", "l.created_at", "u.name as actor_name", "m.name as ministry_name"])
    .where("l.ministry_id", "in", scope.ministryIds).where("l.visibility", "=", "ministry").where("l.summary", "is not", null)
    .orderBy("l.created_at", "desc").limit(limit).execute();
}

export async function syncAlerts(trx: Tx) {
  // RLS: apenas visão global enxerga contas e jobs.
  const accounts = await trx.selectFrom("app.connected_accounts").select(["id", "label", "provider", "status", "last_error", "last_error_at", "token_expires_at"])
    .where((eb) => eb.or([eb("status", "in", ["error", "expired", "revoked"]), eb("token_expires_at", "<", new Date(Date.now() + 10 * 86400_000))]))
    .where("status", "<>", "disconnected").execute();
  const failedJobs = await trx.selectFrom("app.sync_jobs").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("status", "=", "failed").where("finished_at", ">", new Date(Date.now() - 86400_000)).executeTakeFirst();
  return { accounts, failedJobs: Number(failedJobs?.n ?? 0) };
}

// ---------------------------------------------------------------------------
// Composição do dashboard
// ---------------------------------------------------------------------------
export interface CommunicationKpis {
  paid: Record<"spend" | "impressions" | "reach" | "clicks" | "videoViews" | "results" | "ctr" | "cpc" | "cpm" | "costPerResult", MetricValue>;
  paidChange: Partial<Record<"spend" | "impressions" | "clicks" | "results", Change>>;
  organic: Record<string, { posts: number; reach: MetricValue; views: MetricValue; engagement: MetricValue }>;
  organicChange: Record<string, Change>;
  currency: string;
  investmentRestricted: boolean;
  investmentPartial: boolean;
}

export async function communicationKpis(trx: Tx, scope: Scope, start: string, end: string, sources: Awaited<ReturnType<typeof sourceStatus>>, investment: { all: boolean; any: boolean }): Promise<CommunicationKpis> {
  const prev = previousPeriod({ start, end });
  const [cur, before, org, orgPrev] = await Promise.all([
    paidTotals(trx, scope, start, end), paidTotals(trx, scope, prev.start, prev.end),
    organicTotals(trx, scope, start, end), organicTotals(trx, scope, prev.start, prev.end),
  ]);
  const derived = derivePaid(cur.totals);
  const paidSrc = { hasSource: sources.meta_ads.connected && (!scope.channel || scope.channel === "meta_ads"), syncing: sources.meta_ads.syncing, updatedAt: cur.lastUpdate };
  const money = (v: number | null) => toMetric(v, { ...paidSrc, restricted: scope.ministryIds.length > 0 && !investment.any });
  const paid = {
    spend: money(cur.totals.spend),
    impressions: toMetric(cur.totals.impressions, paidSrc),
    reach: toMetric(cur.totals.reach, paidSrc),
    clicks: toMetric(cur.totals.clicks, paidSrc),
    videoViews: toMetric(cur.totals.video_views, paidSrc),
    results: toMetric(cur.totals.results, paidSrc),
    ctr: toMetric(derived.ctr, paidSrc),
    cpc: money(derived.cpc),
    cpm: money(derived.cpm),
    costPerResult: money(derived.costPerResult),
  };
  const organic: CommunicationKpis["organic"] = {};
  const organicChange: Record<string, Change> = {};
  for (const platform of ["instagram", "facebook"] as const) {
    if (scope.channel && scope.channel !== platform) continue;
    const t = org.byPlatform[platform];
    const src = { hasSource: sources.organic.connected, syncing: sources.organic.syncing, updatedAt: org.lastUpdate };
    if (!t && !sources.organic.connected) continue;
    organic[platform] = {
      posts: t?.posts ?? 0,
      reach: t ? toMetric(t.reach, src) : sources.organic.connected ? metric.value(0, { note: "Nenhuma publicação no período" }) : metric.disconnected(),
      views: t ? toMetric(t.views, src) : sources.organic.connected ? metric.value(0) : metric.disconnected(),
      engagement: t ? toMetric(organicEngagement(t), src) : sources.organic.connected ? metric.value(0) : metric.disconnected(),
    };
    organicChange[platform] = compare(organicEngagement(t), organicEngagement(orgPrev.byPlatform[platform]));
  }
  return {
    paid,
    paidChange: {
      spend: compare(cur.totals.spend, before.totals.spend), impressions: compare(cur.totals.impressions, before.totals.impressions),
      clicks: compare(cur.totals.clicks, before.totals.clicks), results: compare(cur.totals.results, before.totals.results),
    },
    organic, organicChange, currency: cur.currency ?? "BRL",
    investmentRestricted: scope.ministryIds.length > 0 && !investment.any, investmentPartial: investment.any && !investment.all,
  };
}

async function investmentPermission(trx: Tx, ministryIds: string[]) {
  if (!ministryIds.length) return { all: false, any: false };
  const r = await sql<{ all: boolean; any: boolean }>`
    select coalesce(bool_and(app.can_view_investment(id)), false) as all, coalesce(bool_or(app.can_view_investment(id)), false) as any
    from unnest(${uuidArray(ministryIds)}) as id`.execute(trx);
  return r.rows[0] ?? { all: false, any: false };
}

export async function getDashboard(actor: Actor, f: AnalyticsFilters) {
  return asUser(actor, async (trx) => {
    const scope = await resolveScope(trx, f);
    const [sources, investment] = await Promise.all([sourceStatus(trx, scope), investmentPermission(trx, scope.ministryIds)]);
    const [operational, communication, series, distribution, byMinistry, byCampaign, events, activity, deliveries, posts, alerts] = await Promise.all([
      operationalKpis(trx, scope, f.start, f.end),
      communicationKpis(trx, scope, f.start, f.end, sources, investment),
      timeSeries(trx, scope, f.start, f.end),
      taskStatusDistribution(trx, scope),
      performanceByMinistry(trx, scope, f.start, f.end),
      investment.any ? investmentByCampaign(trx, scope, f.start, f.end) : Promise.resolve(null),
      upcomingEvents(trx, scope),
      recentActivity(trx, scope),
      upcomingDeliveries(trx, scope),
      topPosts(trx, scope, f.start, f.end),
      hasGlobalRead(actor) ? syncAlerts(trx) : Promise.resolve(null),
    ]);
    return { scope, sources, investment, operational, communication, series, distribution, byMinistry, byCampaign, events, activity, deliveries, posts, alerts };
  });
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

/** Desempenho de uma campanha de comunicação (pago + orgânico + metas). */
export async function campaignPerformance(actor: Actor, campaignId: string, start: string, end: string) {
  return asUser(actor, async (trx) => {
    const c = await trx.selectFrom("app.campaigns as c").innerJoin("app.ministries as m", "m.id", "c.ministry_id")
      .select(["c.ministry_id", "m.is_demo"]).where("c.id", "=", campaignId).executeTakeFirst();
    if (!c) return null;
    const scope = await resolveScope(trx, { mode: c.is_demo ? "demo" : "production", start, end, ministryId: c.ministry_id, campaignId });
    const [sources, investment] = await Promise.all([sourceStatus(trx, scope), investmentPermission(trx, scope.ministryIds)]);
    const [communication, series, posts, perExternal, lifetimeReach] = await Promise.all([
      communicationKpis(trx, scope, start, end, sources, investment),
      timeSeries(trx, scope, start, end),
      topPosts(trx, scope, start, end, 10),
      scope.metaCampaignIds?.length
        ? sql<{ entity_id: string; metric_key: string; v: number }>`
            select o.entity_id, o.metric_key, sum(o.value)::float8 as v from app.metric_observations o
            where o.entity_type = 'meta_campaign' and o.granularity = 'day' and o.entity_id = any(${uuidArray(scope.metaCampaignIds)})
              and o.period_start between ${start}::date and ${end}::date group by 1, 2`.execute(trx).then((r) => r.rows)
        : Promise.resolve([]),
      scope.metaCampaignIds?.length
        ? sql<{ entity_id: string; v: number; period_start: string; period_end: string }>`
            select distinct on (o.entity_id) o.entity_id, o.value::float8 as v, o.period_start::text, o.period_end::text from app.metric_observations o
            where o.entity_type = 'meta_campaign' and o.granularity = 'lifetime' and o.metric_key = 'reach' and o.entity_id = any(${uuidArray(scope.metaCampaignIds)})
            order by o.entity_id, o.period_end desc`.execute(trx).then((r) => r.rows)
        : Promise.resolve([]),
    ]);
    const external: Record<string, Record<string, number>> = {};
    for (const row of perExternal) (external[row.entity_id] ??= {})[row.metric_key] = row.v;
    // Totais acumulados (todo o histórico) para metas.
    const allTime = await paidTotals(trx, scope, "2000-01-01", todayIso());
    const allOrganic = await organicTotals(trx, scope, "2000-01-01", todayIso());
    return { scope, sources, investment, communication, series, posts, external, lifetimeReach, allTime: allTime.totals, allOrganic: allOrganic.byPlatform };
  });
}
