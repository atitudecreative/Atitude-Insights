import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { sql, type Tx } from "@/server/db";
import type { Json } from "@/server/db/schema.generated";
import { compare, goalProgress, type Change } from "@/lib/metrics";
import { formatNumber } from "@/lib/format";
import { previousPeriod } from "@/lib/period";
import {
  derivePaid, operationalKpis, organicEngagement, organicTotals, paidTotals, resolveScope, sourceStatus, topPosts, type OrganicTotals,
} from "./analytics";
import { asUser, isUuid, ministryAccess, ServiceError, zodErrors } from "./context";

export interface ReportParams {
  scopeType: "ministry" | "campaign" | "event" | "agency";
  ministryId: string | null;
  campaignId: string | null;
  eventId: string | null;
  channel: string | null;
  start: string;
  end: string;
}

/** Dados do relatório SEM valores monetários (estes ficam em `financials`). */
export interface ReportData {
  generatedAt: string;
  params: ReportParams;
  subject: { ministryName: string | null; ministryNames: string[]; campaignName: string | null; eventName: string | null; isDemo: boolean };
  objectives: Array<{ label: string; text: string }>;
  facts: string[];
  operational: { tasksCompleted: number; tasksCompletedChange: Change; tasksOpen: number; tasksOverdue: number; deliverablesProduced: number; deliverablesChange: Change; activeCampaigns: number };
  tasks: Array<{ name: string; completed_at: string | null; ministry: string; campaign: string | null; source: string }>;
  deliverables: Array<{ title: string; type: string; status: string; date: string | null; campaign: string | null; url: string | null }>;
  campaigns: Array<{ name: string; status: string; start_date: string | null; end_date: string | null; ministry: string; objective: string | null }>;
  paid: { available: boolean; impressions: number | null; reach: number | null; clicks: number | null; results: number | null; videoViews: number | null; ctr: number | null; previous: { impressions: number | null; clicks: number | null; results: number | null } };
  organic: Record<string, { posts: number; reach: number | null; views: number | null; engagement: number | null; previousEngagement: number | null }>;
  topPosts: Array<{ caption: string | null; platform: string; published_at: string; engagement: number | null; permalink: string | null }>;
  goals: Array<{ campaign: string; label: string; unit: string; target: number; actual: number | null; actualSource: string; progress: number | null }>;
  eventResults: Array<{ event: string; label: string; value: number | null; unit: string; source: string; notes: string | null }>;
  notes: { learnings: string[]; observations: string[] };
  sources: Array<{ label: string; status: string; lastUpdate: string | null }>;
}

export interface ReportFinancials {
  currency: string;
  paidSpend: number | null;
  paidSpendPrevious: number | null;
  cpc: number | null;
  cpm: number | null;
  costPerResult: number | null;
  planned: number | null;
  realizedManual: number | null;
  items: Array<{ description: string; kind: string; category: string; amount: number; spent_on: string | null; campaign: string | null }>;
}

const GOAL_METRIC_SOURCES: Record<string, (p: { paid: Record<string, number | null>; organic: Record<string, OrganicTotals> }) => number | null> = {
  impressions: (x) => x.paid.impressions ?? null,
  clicks: (x) => x.paid.clicks ?? null,
  link_clicks: (x) => x.paid.link_clicks ?? null,
  results: (x) => x.paid.results ?? null,
  video_views: (x) => x.paid.video_views ?? null,
  conversions: (x) => x.paid.conversions ?? null,
  ig_engagement: (x) => organicEngagement(x.organic.instagram),
  fb_engagement: (x) => organicEngagement(x.organic.facebook),
  ig_views: (x) => x.organic.instagram?.views ?? null,
};

export const GOAL_METRICS = [
  { key: "impressions", label: "Impressões (Meta Ads)" },
  { key: "clicks", label: "Cliques (Meta Ads)" },
  { key: "link_clicks", label: "Cliques no link (Meta Ads)" },
  { key: "results", label: "Resultados (Meta Ads)" },
  { key: "video_views", label: "Visualizações de vídeo (Meta Ads)" },
  { key: "conversions", label: "Conversões (Meta Ads)" },
  { key: "ig_engagement", label: "Engajamento no Instagram" },
  { key: "fb_engagement", label: "Engajamento no Facebook" },
  { key: "ig_views", label: "Visualizações no Instagram" },
];

const dayStart = (iso: string) => new Date(`${iso}T00:00:00-03:00`);
const dayEnd = (iso: string) => new Date(`${iso}T23:59:59.999-03:00`);

/**
 * Monta os dados do relatório no contexto RLS do usuário. Nada além do que
 * o usuário pode ver entra no relatório (inclusive em exportações PDF).
 */
export async function buildReport(trx: Tx, params: ReportParams): Promise<{ data: ReportData; financials: ReportFinancials | null }> {
  let ministryId = params.ministryId;
  let campaignName: string | null = null;
  let eventName: string | null = null;
  const objectives: ReportData["objectives"] = [];
  const learnings: string[] = [];
  const observations: string[] = [];

  if (params.scopeType === "campaign") {
    const c = await trx.selectFrom("app.campaigns").select(["ministry_id", "name", "objective", "target_audience", "learnings", "observations", "final_summary"])
      .where("id", "=", params.campaignId!).executeTakeFirst();
    if (!c) throw new ServiceError("Campanha não encontrada.", "not_found");
    ministryId = c.ministry_id;
    campaignName = c.name;
    if (c.objective) objectives.push({ label: "Objetivo da campanha", text: c.objective });
    if (c.target_audience) objectives.push({ label: "Público-alvo", text: c.target_audience });
    if (c.learnings) learnings.push(c.learnings);
    if (c.observations) observations.push(c.observations);
    if (c.final_summary) observations.push(c.final_summary);
  }
  if (params.scopeType === "event") {
    const e = await trx.selectFrom("app.events").select(["ministry_id", "name", "communication_objective", "observations", "results_summary"])
      .where("id", "=", params.eventId!).executeTakeFirst();
    if (!e) throw new ServiceError("Evento não encontrado.", "not_found");
    ministryId = e.ministry_id;
    eventName = e.name;
    if (e.communication_objective) objectives.push({ label: "Objetivo de comunicação", text: e.communication_objective });
    if (e.results_summary) observations.push(e.results_summary);
    if (e.observations) observations.push(e.observations);
  }
  if (params.scopeType !== "agency" && !ministryId) throw new ServiceError("Ministério obrigatório.", "invalid");

  let isDemo = false;
  let ministryName: string | null = null;
  if (ministryId) {
    const m = await trx.selectFrom("app.ministries").select(["name", "is_demo"]).where("id", "=", ministryId).executeTakeFirst();
    if (!m) throw new ServiceError("Ministério não encontrado.", "not_found");
    ministryName = m.name;
    isDemo = m.is_demo;
  }

  const scope = await resolveScope(trx, {
    mode: isDemo ? "demo" : "production", start: params.start, end: params.end, ministryId,
    campaignId: params.scopeType === "campaign" ? params.campaignId : null, eventId: params.scopeType === "event" ? params.eventId : null, channel: params.channel,
  });
  const ministryNames = scope.ministryIds.length
    ? (await trx.selectFrom("app.ministries").select("name").where("id", "in", scope.ministryIds).orderBy("name").execute()).map((m) => m.name)
    : [];
  const prev = previousPeriod({ start: params.start, end: params.end });
  const ids = scope.ministryIds.length ? scope.ministryIds : ["00000000-0000-0000-0000-000000000000"];
  const campaignIds = scope.campaignIds;

  const [op, sources, paidCur, paidPrev, orgCur, orgPrev, posts] = await Promise.all([
    operationalKpis(trx, scope, params.start, params.end),
    sourceStatus(trx, scope),
    paidTotals(trx, scope, params.start, params.end),
    paidTotals(trx, scope, prev.start, prev.end),
    organicTotals(trx, scope, params.start, params.end),
    organicTotals(trx, scope, prev.start, prev.end),
    topPosts(trx, scope, params.start, params.end, 8),
  ]);

  let tq = trx.selectFrom("app.tasks as t").innerJoin("app.ministries as m", "m.id", "t.ministry_id").leftJoin("app.campaigns as c", "c.id", "t.campaign_id")
    .select(["t.name", "t.completed_at", "m.name as ministry", "c.name as campaign", "t.source"])
    .where("t.ministry_id", "in", ids).where("t.completed", "=", true)
    .where("t.completed_at", ">=", dayStart(params.start)).where("t.completed_at", "<=", dayEnd(params.end));
  if (campaignIds) tq = tq.where((eb) => eb.or([eb("t.campaign_id", "in", campaignIds.length ? campaignIds : ids), ...(scope.eventId ? [eb("t.event_id", "=", scope.eventId)] : [])]));
  const tasks = await tq.orderBy("t.completed_at", "desc").limit(200).execute();

  let dq = trx.selectFrom("app.deliverables as d").leftJoin("app.campaigns as c", "c.id", "d.campaign_id")
    .select(["d.title", "d.type", "d.status", "d.delivered_at", "d.approved_at", "d.created_at", "d.url", "c.name as campaign"])
    .where("d.ministry_id", "in", ids).where("d.status", "in", ["approved", "delivered"])
    .where(sql<Date>`coalesce(d.delivered_at, d.approved_at, d.created_at)`, ">=", dayStart(params.start))
    .where(sql<Date>`coalesce(d.delivered_at, d.approved_at, d.created_at)`, "<=", dayEnd(params.end));
  if (campaignIds) dq = dq.where((eb) => eb.or([eb("d.campaign_id", "in", campaignIds.length ? campaignIds : ids), ...(scope.eventId ? [eb("d.event_id", "=", scope.eventId)] : [])]));
  const deliverables = await dq.orderBy("d.created_at", "desc").limit(200).execute();

  let cq = trx.selectFrom("app.campaigns as c").innerJoin("app.ministries as m", "m.id", "c.ministry_id")
    .select(["c.id", "c.name", "c.status", "c.start_date", "c.end_date", "m.name as ministry", "c.objective"])
    .where("c.ministry_id", "in", ids).where("c.status", "<>", "archived")
    .where((eb) => eb.and([eb.or([eb("c.start_date", "is", null), eb("c.start_date", "<=", params.end)]), eb.or([eb("c.end_date", "is", null), eb("c.end_date", ">=", params.start)])]));
  if (campaignIds) cq = cq.where("c.id", "in", campaignIds.length ? campaignIds : ["00000000-0000-0000-0000-000000000000"]);
  const campaigns = await cq.orderBy("c.start_date").execute();

  // Metas vs resultados (acumulado do escopo da campanha).
  const goals: ReportData["goals"] = [];
  if (campaigns.length) {
    const goalRows = await trx.selectFrom("app.campaign_goals as g").innerJoin("app.campaigns as c", "c.id", "g.campaign_id")
      .select(["g.label", "g.metric_key", "g.target_value", "g.unit", "g.manual_actual_value", "g.manual_actual_source", "g.campaign_id", "c.name as campaign"])
      .where("g.campaign_id", "in", campaigns.map((c) => c.id)).execute();
    for (const g of goalRows) {
      let actual: number | null = null;
      let actualSource = "Não informado";
      if (g.metric_key && GOAL_METRIC_SOURCES[g.metric_key]) {
        const cs = await resolveScope(trx, { mode: isDemo ? "demo" : "production", start: "2000-01-01", end: params.end, ministryId, campaignId: g.campaign_id });
        const [p, o] = await Promise.all([paidTotals(trx, cs, "2000-01-01", params.end), organicTotals(trx, cs, "2000-01-01", params.end)]);
        actual = GOAL_METRIC_SOURCES[g.metric_key]!({ paid: p.totals, organic: o.byPlatform });
        actualSource = "Métricas sincronizadas (acumulado até o fim do período)";
      } else if (g.manual_actual_value != null) {
        actual = g.manual_actual_value;
        actualSource = g.manual_actual_source ?? "Registro manual";
      }
      goals.push({ campaign: g.campaign, label: g.label, unit: g.unit, target: g.target_value, actual, actualSource, progress: goalProgress(actual, g.target_value) });
    }
  }

  const eventIds = scope.eventId ? [scope.eventId] : [];
  const eventResults = eventIds.length
    ? (await trx.selectFrom("app.event_results as r").innerJoin("app.events as e", "e.id", "r.event_id")
      .select(["e.name as event", "r.label", "r.value", "r.unit", "r.source", "r.notes"]).where("r.event_id", "in", eventIds).execute())
    : [];

  const organic: ReportData["organic"] = {};
  for (const [platform, t] of Object.entries(orgCur.byPlatform)) {
    organic[platform] = { posts: t.posts, reach: t.reach, views: t.views, engagement: organicEngagement(t), previousEngagement: organicEngagement(orgPrev.byPlatform[platform]) };
  }
  const derived = derivePaid(paidCur.totals);

  // Fatos observados (sem interpretações ou relações causais).
  const facts: string[] = [];
  facts.push(`${formatNumber(op.tasksCompleted)} demanda(s) concluída(s) e ${formatNumber(op.deliverablesProduced)} entregável(is) aprovado(s) ou entregue(s) no período.`);
  if (campaigns.length) facts.push(`${campaigns.length} campanha(s) de comunicação com atividade no período.`);
  if (op.tasksOverdue) facts.push(`${formatNumber(op.tasksOverdue)} demanda(s) em aberto com prazo vencido na data de geração.`);
  if (paidCur.totals.impressions != null) facts.push(`Anúncios na Meta geraram ${formatNumber(paidCur.totals.impressions)} impressões e ${formatNumber(paidCur.totals.clicks ?? 0)} cliques (dados informados pela Meta).`);
  for (const [platform, o] of Object.entries(organic)) {
    facts.push(`${o.posts} publicação(ões) no ${platform === "instagram" ? "Instagram" : "Facebook"}${o.engagement != null ? `, com ${formatNumber(o.engagement)} interações registradas` : ""}.`);
  }
  if (!sources.meta_ads.connected && !sources.organic.connected) facts.push("Não há contas da Meta associadas a este escopo; indicadores de mídia não estão disponíveis.");

  const data: ReportData = {
    generatedAt: new Date().toISOString(),
    params: { ...params, ministryId },
    subject: { ministryName, ministryNames, campaignName, eventName, isDemo },
    objectives, facts,
    operational: {
      tasksCompleted: op.tasksCompleted, tasksCompletedChange: op.tasksCompletedChange, tasksOpen: op.tasksOpen, tasksOverdue: op.tasksOverdue,
      deliverablesProduced: op.deliverablesProduced, deliverablesChange: op.deliverablesChange, activeCampaigns: op.activeCampaigns,
    },
    tasks: tasks.map((t) => ({ name: t.name, completed_at: t.completed_at ? new Date(t.completed_at).toISOString() : null, ministry: t.ministry, campaign: t.campaign, source: t.source })),
    deliverables: deliverables.map((d) => ({ title: d.title, type: d.type, status: d.status, date: new Date(d.delivered_at ?? d.approved_at ?? d.created_at).toISOString(), campaign: d.campaign, url: d.url })),
    campaigns: campaigns.map(({ id: _id, ...c }) => c),
    paid: {
      available: sources.meta_ads.connected, impressions: paidCur.totals.impressions, reach: paidCur.totals.reach, clicks: paidCur.totals.clicks,
      results: paidCur.totals.results, videoViews: paidCur.totals.video_views, ctr: derived.ctr,
      previous: { impressions: paidPrev.totals.impressions, clicks: paidPrev.totals.clicks, results: paidPrev.totals.results },
    },
    organic,
    topPosts: posts.map((p) => ({ caption: p.caption, platform: p.platform, published_at: new Date(p.published_at).toISOString(), engagement: p.engagement, permalink: p.permalink })),
    goals,
    eventResults,
    notes: { learnings, observations },
    sources: [
      { label: "Asana (demandas)", status: sources.asana.connected ? "conectado" : "sem dados", lastUpdate: sources.asana.lastUpdate },
      { label: "Meta Ads (pago)", status: sources.meta_ads.connected ? "conectado" : "sem conexão", lastUpdate: paidCur.lastUpdate ?? sources.meta_ads.lastUpdate },
      { label: "Instagram/Facebook (orgânico)", status: sources.organic.connected ? "conectado" : "sem conexão", lastUpdate: orgCur.lastUpdate ?? sources.organic.lastUpdate },
      { label: "Registros do portal (campanhas, entregáveis, investimentos)", status: "portal", lastUpdate: new Date().toISOString() },
    ],
  };

  // Seção financeira — somente se o usuário pode ver investimentos de TODO o escopo.
  const perms = await sql<{ all: boolean }>`select coalesce(bool_and(app.can_view_investment(id)), false) as all from unnest(${`{${ids.join(",")}}`}::uuid[]) as id`.execute(trx);
  let financials: ReportFinancials | null = null;
  if (perms.rows[0]?.all && scope.ministryIds.length) {
    let iq = trx.selectFrom("app.investments as i").leftJoin("app.campaigns as c", "c.id", "i.campaign_id")
      .select(["i.description", "i.kind", "i.category", "i.amount", "i.spent_on", "c.name as campaign"]).where("i.ministry_id", "in", ids)
      .where((eb) => eb.or([eb("i.kind", "=", "planned"), eb("i.spent_on", "is", null), eb.and([eb("i.spent_on", ">=", params.start), eb("i.spent_on", "<=", params.end)])]));
    if (campaignIds) iq = iq.where("i.campaign_id", "in", campaignIds.length ? campaignIds : ["00000000-0000-0000-0000-000000000000"]);
    const items = await iq.orderBy("i.spent_on").execute();
    const sum = (k: string) => { const v = items.filter((i) => i.kind === k); return v.length ? v.reduce((a, b) => a + b.amount, 0) : null; };
    financials = {
      currency: paidCur.currency ?? "BRL", paidSpend: paidCur.totals.spend, paidSpendPrevious: paidPrev.totals.spend,
      cpc: derived.cpc, cpm: derived.cpm, costPerResult: derived.costPerResult,
      planned: sum("planned"), realizedManual: sum("realized"),
      items: items.map((i) => ({ ...i })),
    };
  }
  return { data, financials };
}

export const reportParamsSchema = z.object({
  scopeType: z.enum(["ministry", "campaign", "event", "agency"]),
  ministryId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  campaignId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  eventId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  channel: z.union([z.enum(["meta_ads", "instagram", "facebook"]), z.literal("")]).optional().transform((v) => v || null),
  start: z.iso.date("Data inicial inválida"),
  end: z.iso.date("Data final inválida"),
}).refine((v) => v.end >= v.start, { message: "Período inválido", path: ["end"] })
  .refine((v) => v.scopeType !== "ministry" || v.ministryId, { message: "Selecione o ministério", path: ["ministryId"] })
  .refine((v) => v.scopeType !== "campaign" || v.campaignId, { message: "Selecione a campanha", path: ["campaignId"] })
  .refine((v) => v.scopeType !== "event" || v.eventId, { message: "Selecione o evento", path: ["eventId"] });

/** Relatório instantâneo (pré-visualização / PDF sem salvar). */
export async function liveReport(actor: Actor, raw: unknown) {
  const parsed = reportParamsSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Parâmetros inválidos.", "invalid", zodErrors(parsed.error.issues));
  return asUser(actor, async (trx) => {
    if (parsed.data.scopeType === "agency" && !(await ministryAccess(trx, null)).canRead) throw new ServiceError("Sem permissão.", "forbidden");
    if (parsed.data.ministryId && !(await ministryAccess(trx, parsed.data.ministryId)).canRead) throw new ServiceError("Não encontrado.", "not_found");
    return buildReport(trx, parsed.data);
  });
}

export async function listReports(actor: Actor, f: { ministryId?: string; limit?: number }) {
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.reports as r").leftJoin("app.ministries as m", "m.id", "r.ministry_id").leftJoin("app.users as u", "u.id", "r.created_by")
      .select(["r.id", "r.title", "r.scope_type", "r.status", "r.period_start", "r.period_end", "r.published_at", "r.updated_at", "m.name as ministry_name", "u.name as author"]);
    if (isUuid(f.ministryId)) q = q.where("r.ministry_id", "=", f.ministryId);
    return q.orderBy("r.updated_at", "desc").limit(f.limit ?? 100).execute();
  });
}

export const reportTextSchema = z.object({
  title: z.string().trim().min(3, "Informe o título").max(200),
  objectives: z.string().trim().max(10000).optional().transform((v) => v || null),
  executiveSummary: z.string().trim().max(20000).optional().transform((v) => v || null),
  learnings: z.string().trim().max(10000).optional().transform((v) => v || null),
  observations: z.string().trim().max(10000).optional().transform((v) => v || null),
});

export async function createReport(actor: Actor, raw: Record<string, unknown>): Promise<string> {
  const params = reportParamsSchema.safeParse(raw);
  const text = reportTextSchema.safeParse(raw);
  if (!params.success || !text.success) {
    throw new ServiceError("Verifique os campos.", "invalid", zodErrors([...(params.error?.issues ?? []), ...(text.error?.issues ?? [])]));
  }
  const p = params.data;
  return asUser(actor, async (trx) => {
    let ministryId = p.ministryId;
    if (p.scopeType === "campaign") ministryId = (await trx.selectFrom("app.campaigns").select("ministry_id").where("id", "=", p.campaignId!).executeTakeFirst())?.ministry_id ?? null;
    if (p.scopeType === "event") ministryId = (await trx.selectFrom("app.events").select("ministry_id").where("id", "=", p.eventId!).executeTakeFirst())?.ministry_id ?? null;
    if (p.scopeType === "agency") ministryId = null;
    if (p.scopeType !== "agency" && !ministryId) throw new ServiceError("Escopo não encontrado.", "not_found");
    const row = await trx.insertInto("app.reports").values({
      ministry_id: ministryId, scope_type: p.scopeType, campaign_id: p.scopeType === "campaign" ? p.campaignId : null, event_id: p.scopeType === "event" ? p.eventId : null,
      channel_key: p.channel, period_start: p.start, period_end: p.end, title: text.data.title, objectives: text.data.objectives,
      executive_summary: text.data.executiveSummary, learnings: text.data.learnings, observations: text.data.observations, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, { ministryId, entityType: "report", entityId: row.id, action: "created", summary: `Relatório "${text.data.title}" criado (rascunho)` });
    return row.id;
  });
}

export async function getReport(actor: Actor, id: string) {
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const report = await trx.selectFrom("app.reports as r").leftJoin("app.ministries as m", "m.id", "r.ministry_id").leftJoin("app.users as u", "u.id", "r.created_by")
      .select(["r.id", "r.ministry_id", "r.scope_type", "r.campaign_id", "r.event_id", "r.channel_key", "r.period_start", "r.period_end", "r.title", "r.status",
        "r.objectives", "r.executive_summary", "r.learnings", "r.observations", "r.published_at", "r.created_at", "r.updated_at", "m.name as ministry_name", "u.name as author"])
      .where("r.id", "=", id).executeTakeFirst();
    if (!report) return null;
    const access = await ministryAccess(trx, report.ministry_id);
    const versions = await trx.selectFrom("app.report_versions as v").leftJoin("app.users as u", "u.id", "v.created_by")
      .select(["v.id", "v.version", "v.created_at", "u.name as author"]).where("v.report_id", "=", id).orderBy("v.version", "desc").execute();
    return { report, access, versions };
  });
}

export async function getReportVersion(actor: Actor, reportId: string, versionId?: string) {
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.report_versions").select(["id", "version", "snapshot", "created_at"]).where("report_id", "=", reportId);
    q = versionId && isUuid(versionId) ? q.where("id", "=", versionId) : q.orderBy("version", "desc").limit(1);
    const v = await q.executeTakeFirst();
    if (!v) return null;
    const fin = await trx.selectFrom("app.report_version_financials").select("data").where("report_version_id", "=", v.id).executeTakeFirst();
    return { version: v.version, createdAt: v.created_at, data: v.snapshot as unknown as ReportData, financials: (fin?.data as unknown as ReportFinancials) ?? null };
  });
}

export async function updateReportText(actor: Actor, id: string, raw: unknown): Promise<void> {
  const parsed = reportTextSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.reports").set({
      title: parsed.data.title, objectives: parsed.data.objectives, executive_summary: parsed.data.executiveSummary,
      learnings: parsed.data.learnings, observations: parsed.data.observations,
    }).where("id", "=", id).returning("ministry_id").executeTakeFirst();
    if (!r) throw new ServiceError("Sem permissão para editar este relatório.", "forbidden");
    await audit(trx, { ministryId: r.ministry_id, entityType: "report", entityId: id, action: "updated", summary: "Texto do relatório revisado" });
  });
}

export function reportParamsFromRow(r: { scope_type: string; ministry_id: string | null; campaign_id: string | null; event_id: string | null; channel_key: string | null; period_start: string; period_end: string }): ReportParams {
  return {
    scopeType: r.scope_type as ReportParams["scopeType"], ministryId: r.ministry_id, campaignId: r.campaign_id, eventId: r.event_id,
    channel: r.channel_key, start: r.period_start, end: r.period_end,
  };
}

/** Publica: congela os dados revisados em uma nova versão (dados + financeiro separados). */
export async function publishReport(actor: Actor, id: string): Promise<number> {
  return asUser(actor, async (trx) => {
    const r = await trx.selectFrom("app.reports").select(["id", "ministry_id", "scope_type", "campaign_id", "event_id", "channel_key", "period_start", "period_end", "title"])
      .where("id", "=", id).executeTakeFirst();
    if (!r) throw new ServiceError("Relatório não encontrado.", "not_found");
    if (!(await ministryAccess(trx, r.ministry_id)).canManage) throw new ServiceError("Sem permissão para publicar.", "forbidden");
    const { data, financials } = await buildReport(trx, reportParamsFromRow(r));
    const last = await trx.selectFrom("app.report_versions").select((eb) => eb.fn.max("version").as("v")).where("report_id", "=", id).executeTakeFirst();
    const version = Number(last?.v ?? 0) + 1;
    const v = await trx.insertInto("app.report_versions").values({ report_id: id, ministry_id: r.ministry_id, version, snapshot: JSON.stringify(data) as unknown as Json })
      .returning("id").executeTakeFirstOrThrow();
    if (financials) await trx.insertInto("app.report_version_financials").values({ report_version_id: v.id, ministry_id: r.ministry_id, data: JSON.stringify(financials) as unknown as Json }).execute();
    await trx.updateTable("app.reports").set({ status: "published", published_at: new Date() }).where("id", "=", id).execute();
    await audit(trx, { ministryId: r.ministry_id, entityType: "report", entityId: id, action: "published", summary: `Relatório "${r.title}" publicado (versão ${version})` });
    return version;
  });
}

export async function deleteReport(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.reports").where("id", "=", id).returning(["ministry_id", "title"]).executeTakeFirst();
    if (!r) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: r.ministry_id, entityType: "report", entityId: id, action: "deleted", summary: `Relatório "${r.title}" excluído` });
  });
}

export { compare };
