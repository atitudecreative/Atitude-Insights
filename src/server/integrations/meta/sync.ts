import { sql, type Database } from "@/server/db";
import type { Json } from "@/server/db/schema.generated";
import { classifyByAsset, classifyMetaCampaign, type Classification, type MappingRule } from "../classification";
import { saveCredentials } from "../credentials";
import { IntegrationError } from "../http";
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from "../jobs";
import { MetaApiError, MetaClient, type GraphPage, type PageCursor } from "./client";
import {
  ACTION_DERIVED_METRICS, FACEBOOK_POST_METRICS, INSTAGRAM_MEDIA_METRICS, insightItemValue, insightRowToMetrics, toMetricNumber,
  type InsightRow,
} from "./metrics";

/**
 * Jobs de sincronização da Meta:
 * - meta_discover: contas de anúncios, Páginas e contas do Instagram (ativos);
 * - meta_ads: campanhas/conjuntos/anúncios + insights diários e vitalícios;
 * - meta_organic: publicações do Instagram e do Facebook + métricas.
 * Tudo é idempotente (upserts por chave natural) e retomável: o progresso é
 * salvo entre páginas/ativos e, ao atingir ctx.deadline, o job devolve
 * 'continue' para ser reenfileirado de onde parou.
 */

/** Janela de backfill na primeira sincronização de anúncios (dias). */
export const ADS_BACKFILL_DAYS = 90;
/** Janela de atualização incremental (a Meta revisa a atribuição por ~28 dias). */
export const ADS_REFRESH_DAYS = 28;
/** Tamanho máximo de cada intervalo de consulta de insights (dias). */
export const INSIGHTS_CHUNK_DAYS = 31;
export const ORGANIC_BACKFILL_DAYS = 90;
export const ORGANIC_REFRESH_DAYS = 30;
export const ORGANIC_ACCOUNT_REACH_DAYS = 28;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------
// Utilidades de data
// ---------------------------------------------------------------------
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return isoDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

/** Data de hoje no fuso da conta de anúncios (insights da Meta usam esse fuso). */
export function todayInTimeZone(timeZone: string | null | undefined, now: Date = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
      // fuso desconhecido: usa UTC
    }
  }
  return isoDate(now);
}

export function splitRange(since: string, until: string, maxDays: number): Array<{ since: string; until: string }> {
  const out: Array<{ since: string; until: string }> = [];
  let start = since;
  while (start <= until) {
    const end = addDays(start, maxDays - 1);
    out.push({ since: start, until: end < until ? end : until });
    start = addDays(end, 1);
  }
  return out;
}

// ---------------------------------------------------------------------
// Infraestrutura comum
// ---------------------------------------------------------------------
interface AssetRow {
  id: string;
  external_id: string;
  name: string;
  asset_type: string;
  metadata: Json;
  sync_cursor: Json;
}

interface AssetState {
  assetId: string;
  step: number;
  chunk: number;
  cursor: PageCursor | null;
  since?: string;
  until?: string;
}

interface Progress {
  done: string[];
  current?: AssetState;
  warnings: string[];
}

function readProgress(raw: Record<string, unknown> | null | undefined): Progress {
  const p = (raw ?? {}) as Partial<Progress>;
  return {
    done: Array.isArray(p.done) ? p.done.filter((x): x is string => typeof x === "string") : [],
    current: p.current && typeof p.current === "object" ? p.current : undefined,
    warnings: Array.isArray(p.warnings) ? p.warnings.filter((x): x is string => typeof x === "string") : [],
  };
}

const asObject = (value: Json | null | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toJson = (value: unknown): Json => JSON.stringify(value) as unknown as Json;

/** Controle de prazo/checkpoint compartilhado pelos handlers. */
class Run {
  /** Garante progresso: só interrompe depois de ao menos uma página nesta execução. */
  didWork = false;
  readonly stats: Record<string, number> = {};
  private readonly availability = new Map<string, boolean>();

  constructor(readonly ctx: JobContext, readonly progress: Progress) {}

  count(key: string, n = 1) {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  warn(message: string, context: Record<string, unknown> = {}) {
    if (!this.progress.warnings.includes(message)) {
      if (this.progress.warnings.length < 50) this.progress.warnings.push(message);
      this.ctx.log.warn(message, context);
    }
  }

  save() {
    return this.ctx.saveProgress(this.progress as unknown as Record<string, unknown>);
  }

  async shouldStop(): Promise<boolean> {
    if (this.didWork && Date.now() >= this.ctx.deadline) {
      await this.save();
      return true;
    }
    return false;
  }

  /** Disponibilidade já determinada nesta execução (undefined = desconhecida). */
  knownAvailability(assetId: string, scope: string, metricKey: string): boolean | undefined {
    return this.availability.get(`${assetId}|${scope}|${metricKey}`);
  }

  async recordAvailability(assetId: string, scope: string, metricKey: string, available: boolean, reason: string | null) {
    const key = `${assetId}|${scope}|${metricKey}`;
    if (this.availability.get(key) === available) return;
    this.availability.set(key, available);
    await this.ctx.db.insertInto("app.metric_availability").values({
      external_asset_id: assetId, metric_key: metricKey, scope, available, reason: reason?.slice(0, 500) ?? null,
    }).onConflict((oc) => oc.columns(["external_asset_id", "metric_key", "scope"]).doUpdateSet({
      available, reason: reason?.slice(0, 500) ?? null, checked_at: new Date(),
    })).execute();
    if (!available) this.warn(`Métrica "${metricKey}" indisponível (${scope})`, { assetId, reason });
  }

  outcome(message: string): JobOutcome {
    if (this.progress.warnings.length > 0) {
      const shown = this.progress.warnings.slice(0, 5).join("; ");
      const more = this.progress.warnings.length > 5 ? ` (+${this.progress.warnings.length - 5})` : "";
      return { status: "partial", stats: this.stats, message: `Sincronização parcial — ${shown}${more}` };
    }
    return { status: "succeeded", stats: this.stats, message };
  }
}

function userClient(ctx: JobContext): MetaClient {
  return new MetaClient({ accessToken: ctx.credentials.accessToken, version: ctx.graphVersion, appSecret: ctx.config.metaAppSecret, http: ctx.http });
}

/**
 * Percorre páginas a partir de state.cursor, salvando o cursor após cada
 * página. `onPage` pode devolver true para encerrar antes (ex.: corte por data).
 */
async function runPaged<T>(
  run: Run,
  state: AssetState,
  fetchPage: (cursor: PageCursor | null) => Promise<GraphPage<T>>,
  onPage: (items: T[]) => Promise<boolean | void>,
): Promise<"done" | "continue"> {
  for (;;) {
    if (await run.shouldStop()) return "continue";
    const page = await fetchPage(state.cursor);
    const stop = await onPage(page.data);
    run.didWork = true;
    state.cursor = stop ? null : page.next;
    if (!state.cursor) return "done";
    await run.save();
  }
}

/** Percorre os ativos habilitados, retomando do ativo/etapa salvos. */
async function forEachAsset(
  run: Run,
  assets: AssetRow[],
  init: (asset: AssetRow) => Partial<AssetState>,
  process: (asset: AssetRow, state: AssetState) => Promise<"done" | "continue">,
): Promise<"done" | "continue"> {
  for (const asset of assets) {
    if (run.progress.done.includes(asset.id)) continue;
    if (run.progress.current?.assetId !== asset.id) {
      run.progress.current = { assetId: asset.id, step: 0, chunk: 0, cursor: null, ...init(asset) };
    }
    const state = run.progress.current;
    if ((await process(asset, state)) === "continue") return "continue";
    run.progress.done.push(asset.id);
    run.progress.current = undefined;
    run.count("assets");
    await run.save();
  }
  return "done";
}

async function runSteps(
  run: Run,
  state: AssetState,
  steps: ReadonlyArray<() => Promise<"done" | "continue">>,
): Promise<"done" | "continue"> {
  while (state.step < steps.length) {
    const step = steps[state.step]!;
    if ((await step()) === "continue") return "continue";
    state.step++;
    state.chunk = 0;
    state.cursor = null;
    await run.save();
  }
  return "done";
}

async function enabledAssets(db: Database, accountId: string, assetType: string): Promise<AssetRow[]> {
  return db.selectFrom("app.external_assets")
    .select(["id", "external_id", "name", "asset_type", "metadata", "sync_cursor"])
    .where("connected_account_id", "=", accountId).where("provider", "=", "meta").where("asset_type", "=", assetType)
    .where("sync_enabled", "=", true).where("removed_at", "is", null)
    .orderBy("id").execute();
}

interface ClassificationContext {
  rules: MappingRule[];
  assetMinistries: Map<string, string[]>;
}

async function loadClassificationContext(db: Database, assetIds: string[]): Promise<ClassificationContext> {
  const rules = await db.selectFrom("app.mapping_rules")
    .select(["id", "rule_type", "external_asset_id", "match_field", "match_value", "ministry_id", "campaign_id", "event_id", "priority", "active"])
    .where("provider", "=", "meta").where("active", "=", true).execute();
  const assetMinistries = new Map<string, string[]>();
  if (assetIds.length > 0) {
    const rows = await db.selectFrom("app.asset_ministry_mappings").select(["external_asset_id", "ministry_id"])
      .where("external_asset_id", "in", assetIds).execute();
    for (const row of rows) assetMinistries.set(row.external_asset_id, [...(assetMinistries.get(row.external_asset_id) ?? []), row.ministry_id]);
  }
  return { rules: rules as MappingRule[], assetMinistries };
}

interface ObservationInput {
  metricKey: string;
  source: "meta_ads" | "instagram" | "facebook";
  entityType: "meta_campaign" | "meta_ad_set" | "meta_ad" | "social_post" | "external_asset";
  entityId: string;
  granularity: "day" | "lifetime" | "snapshot";
  periodStart: string;
  periodEnd: string;
  dimensionKey?: string;
  value: number;
  ministryId: string | null;
  currency?: string | null;
  externalAssetId: string;
}

/** Upsert pela chave natural: reexecuções atualizam o valor, nunca duplicam. */
async function upsertObservations(run: Run, rows: ObservationInput[]): Promise<number> {
  const unique = new Map<string, ObservationInput>();
  for (const r of rows) {
    if (r.periodEnd < r.periodStart) continue;
    unique.set([r.metricKey, r.source, r.entityType, r.entityId, r.granularity, r.periodStart, r.periodEnd, r.dimensionKey ?? ""].join("|"), r);
  }
  const all = [...unique.values()];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    await run.ctx.db.insertInto("app.metric_observations").values(chunk.map((r) => ({
      metric_key: r.metricKey, source: r.source, entity_type: r.entityType, entity_id: r.entityId, granularity: r.granularity,
      period_start: r.periodStart, period_end: r.periodEnd, dimension_key: r.dimensionKey ?? "", value: r.value,
      ministry_id: r.ministryId, currency: r.currency ?? null, connected_account_id: run.ctx.account.id,
      external_asset_id: r.externalAssetId, api_version: run.ctx.graphVersion,
    }))).onConflict((oc) => oc
      .columns(["metric_key", "source", "entity_type", "entity_id", "granularity", "period_start", "period_end", "dimension_key"])
      .doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        ministry_id: eb.ref("excluded.ministry_id"),
        currency: eb.ref("excluded.currency"),
        connected_account_id: eb.ref("excluded.connected_account_id"),
        external_asset_id: eb.ref("excluded.external_asset_id"),
        api_version: eb.ref("excluded.api_version"),
        collected_at: sql<Date>`now()`,
      })))
      .execute();
  }
  run.count("observations", all.length);
  return all.length;
}

function isOptionalMetricError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError && (error.kind === "invalid_request" || error.kind === "permission" || error.kind === "not_found");
}

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: unknown; end_time?: string }>; total_value?: { value?: unknown } }>;
}

/** Mídia publicada antes da conversão para conta profissional: sem insights. */
const MEDIA_WITHOUT_INSIGHTS_SUBCODES = new Set([2108006]);

/**
 * Busca métricas de /{objeto}/insights tratando cada métrica como opcional:
 * se o lote falhar (ex.: código 100, métrica não suportada para o tipo de
 * mídia), repete métrica a métrica e registra a disponibilidade.
 * Retorna valores por chave do portal.
 */
async function collectOptionalInsights(
  run: Run,
  client: MetaClient,
  objectId: string,
  metrics: ReadonlyArray<readonly [string, string]>,
  availability: { assetId: string; scope: string },
): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  const candidates = metrics.filter(([, key]) => run.knownAvailability(availability.assetId, availability.scope, key) !== false);
  if (candidates.length === 0) return values;

  const read = (response: InsightsResponse, batch: ReadonlyArray<readonly [string, string]>) => {
    for (const item of response?.data ?? []) {
      const match = batch.find(([api]) => api === item.name);
      if (!match) continue;
      const value = insightItemValue(item);
      if (value !== undefined) values.set(match[1], value);
    }
  };

  try {
    const response = await client.get<InsightsResponse>(`${objectId}/insights`, { metric: candidates.map(([api]) => api).join(",") });
    read(response, candidates);
    for (const [, key] of candidates) await run.recordAvailability(availability.assetId, availability.scope, key, true, null);
    return values;
  } catch (error) {
    if (!isOptionalMetricError(error)) throw error;
    if (error instanceof MetaApiError && error.subcode !== undefined && MEDIA_WITHOUT_INSIGHTS_SUBCODES.has(error.subcode)) {
      run.count("insightsSkipped");
      return values;
    }
    if (candidates.length === 1) {
      await run.recordAvailability(availability.assetId, availability.scope, candidates[0]![1], false, error.message);
      return values;
    }
  }
  for (const metric of candidates) {
    try {
      const response = await client.get<InsightsResponse>(`${objectId}/insights`, { metric: metric[0] });
      read(response, [metric]);
      await run.recordAvailability(availability.assetId, availability.scope, metric[1], true, null);
    } catch (error) {
      if (!isOptionalMetricError(error)) throw error;
      await run.recordAvailability(availability.assetId, availability.scope, metric[1], false, error.message);
    }
  }
  return values;
}

async function finishAssetCursor(db: Database, asset: AssetRow, patch: Record<string, unknown>) {
  await db.updateTable("app.external_assets").set({
    sync_cursor: toJson({ ...asObject(asset.sync_cursor), ...patch }), last_synced_at: new Date(),
  }).where("id", "=", asset.id).execute();
}

// ---------------------------------------------------------------------
// Descoberta
// ---------------------------------------------------------------------
interface RawAdAccount {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
}

interface RawPage {
  id: string;
  name?: string;
  access_token?: string;
  category?: string;
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
}

async function upsertAsset(
  ctx: JobContext,
  input: { assetType: "meta_ad_account" | "facebook_page" | "instagram_account"; externalId: string; name: string; metadata: Record<string, unknown>; parentAssetId?: string | null },
): Promise<string | null> {
  const row = await ctx.db.insertInto("app.external_assets").values({
    connected_account_id: ctx.account.id, provider: "meta", asset_type: input.assetType, external_id: input.externalId,
    name: input.name, metadata: toJson(input.metadata), parent_asset_id: input.parentAssetId ?? null, sync_enabled: false,
  }).onConflict((oc) => oc.columns(["provider", "asset_type", "external_id"]).doUpdateSet((eb) => ({
    // sync_enabled NUNCA é alterado em ativos existentes.
    name: eb.ref("excluded.name"),
    metadata: eb.ref("excluded.metadata"),
    parent_asset_id: eb.ref("excluded.parent_asset_id"),
    connected_account_id: eb.ref("excluded.connected_account_id"),
    removed_at: null,
  })).where((eb) => eb.or([
    // Um ativo visível por outra conta conectada só é assumido se lá foi removido.
    eb("app.external_assets.connected_account_id", "=", ctx.account.id),
    eb("app.external_assets.removed_at", "is not", null),
  ]))).returning("id").executeTakeFirst();
  if (row) return row.id;
  ctx.log.warn("Ativo já vinculado a outra conta conectada da Meta; ignorado", { assetType: input.assetType, externalId: input.externalId });
  return null;
}

export const metaDiscoverHandler: JobHandler = async (ctx) => {
  const client = userClient(ctx);
  const stats: Record<string, number> = { adAccounts: 0, pages: 0, instagramAccounts: 0, removed: 0 };
  const seen: string[] = [];

  const adAccounts = await client.getAll<RawAdAccount>("me/adaccounts", {
    fields: "id,account_id,name,account_status,currency,timezone_name", limit: 100,
  });
  for (const account of adAccounts) {
    if (!account.id) continue;
    const externalId = account.id.startsWith("act_") ? account.id : `act_${account.id}`;
    const id = await upsertAsset(ctx, {
      assetType: "meta_ad_account", externalId, name: account.name ?? externalId,
      metadata: { currency: account.currency ?? null, timezone: account.timezone_name ?? null, account_status: account.account_status ?? null, account_id: account.account_id ?? null },
    });
    if (id) { seen.push(id); stats.adAccounts!++; }
  }

  const pages = await client.getAll<RawPage>("me/accounts", {
    fields: "id,name,access_token,category,instagram_business_account{id,username,name,profile_picture_url}", limit: 100,
  });
  const pageTokens: Record<string, string> = {};
  for (const page of pages) {
    if (!page.id) continue;
    if (page.access_token) pageTokens[page.id] = page.access_token;
    const pageAssetId = await upsertAsset(ctx, {
      assetType: "facebook_page", externalId: page.id, name: page.name ?? page.id,
      metadata: { category: page.category ?? null, instagram_account_id: page.instagram_business_account?.id ?? null, has_page_token: Boolean(page.access_token) },
    });
    if (pageAssetId) { seen.push(pageAssetId); stats.pages!++; }
    const ig = page.instagram_business_account;
    if (ig?.id) {
      const igAssetId = await upsertAsset(ctx, {
        assetType: "instagram_account", externalId: ig.id, name: ig.username ? `@${ig.username}` : (ig.name ?? ig.id),
        metadata: { username: ig.username ?? null, name: ig.name ?? null, profile_picture_url: ig.profile_picture_url ?? null, page_id: page.id },
        parentAssetId: pageAssetId,
      });
      if (igAssetId) { seen.push(igAssetId); stats.instagramAccounts!++; }
    }
  }

  // Tokens de Página (cifrados junto às demais credenciais).
  const credentials = { ...ctx.credentials, pageTokens };
  await saveCredentials(ctx.db, ctx.account.id, credentials, ctx.keys);
  ctx.credentials.pageTokens = pageTokens;

  let removedQuery = ctx.db.updateTable("app.external_assets").set({ removed_at: new Date() })
    .where("connected_account_id", "=", ctx.account.id).where("provider", "=", "meta")
    .where("asset_type", "in", ["meta_ad_account", "facebook_page", "instagram_account"]).where("removed_at", "is", null);
  if (seen.length > 0) removedQuery = removedQuery.where("id", "not in", seen);
  const removed = await removedQuery.executeTakeFirst();
  stats.removed = Number(removed.numUpdatedRows ?? 0);
  if (stats.removed > 0) ctx.log.warn(`${stats.removed} ativo(s) não retornado(s) pela Meta foram marcados como removidos`);

  return {
    status: "succeeded", stats,
    message: `Descoberta concluída: ${stats.adAccounts} conta(s) de anúncios, ${stats.pages} Página(s), ${stats.instagramAccounts} conta(s) do Instagram`,
  };
};

// ---------------------------------------------------------------------
// Anúncios (Marketing API)
// ---------------------------------------------------------------------
interface RawCampaign {
  id: string;
  name?: string;
  objective?: string;
  status?: string;
  effective_status?: string;
  start_time?: string;
  stop_time?: string;
}

interface RawAdSet {
  id: string;
  name?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  optimization_goal?: string;
  start_time?: string;
  end_time?: string;
}

interface RawAd {
  id: string;
  name?: string;
  adset_id?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  creative?: { thumbnail_url?: string };
}

const CAMPAIGN_FIELDS = "id,name,objective,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget,buying_type";
const ADSET_FIELDS = "id,name,campaign_id,status,effective_status,optimization_goal,start_time,end_time";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{thumbnail_url}";
const INSIGHT_FIELDS = [
  "campaign_id", "ad_id", "date_start", "date_stop", "spend", "impressions", "reach", "frequency", "clicks",
  "inline_link_clicks", "ctr", "cpc", "cpm", "actions", "action_values", "cost_per_action_type",
].join(",");
const LIFETIME_FIELDS = "campaign_id,reach,impressions,spend,date_start,date_stop";

const manualKeep = <T,>(column: string) =>
  sql<T>`case when ${sql.ref(`external_campaigns.classification`)} = 'manual' then ${sql.ref(`external_campaigns.${column}`)} else ${sql.ref(`excluded.${column}`)} end`;

async function upsertCampaigns(run: Run, asset: AssetRow, items: RawCampaign[], cls: ClassificationContext) {
  const unique = new Map(items.filter((c) => c?.id).map((c) => [c.id, c]));
  if (unique.size === 0) return;
  const values = [...unique.values()].map((c) => {
    const k: Classification = classifyMetaCampaign({ adAccountAssetId: asset.id, name: c.name ?? "" }, cls.rules, cls.assetMinistries);
    return {
      external_asset_id: asset.id, external_id: c.id, name: c.name ?? c.id, objective: c.objective ?? null,
      status: c.status ?? null, effective_status: c.effective_status ?? null,
      start_time: c.start_time ?? null, stop_time: c.stop_time ?? null,
      // Orçamentos (daily/lifetime_budget) ficam SOMENTE no raw (não expostos ao papel da aplicação).
      raw: toJson(c), ministry_id: k.ministryId, classification: k.classification, classification_reason: k.reason,
      removed_in_source_at: null,
    };
  });
  await run.ctx.db.insertInto("app.external_campaigns").values(values)
    .onConflict((oc) => oc.columns(["external_asset_id", "external_id"]).doUpdateSet((eb) => ({
      name: eb.ref("excluded.name"), objective: eb.ref("excluded.objective"), status: eb.ref("excluded.status"),
      effective_status: eb.ref("excluded.effective_status"), start_time: eb.ref("excluded.start_time"),
      stop_time: eb.ref("excluded.stop_time"), raw: eb.ref("excluded.raw"), removed_in_source_at: null,
      ministry_id: manualKeep<string | null>("ministry_id"),
      classification: manualKeep<string>("classification"),
      classification_reason: manualKeep<string | null>("classification_reason"),
    }))).execute();
  run.count("campaigns", values.length);
}

async function campaignMap(db: Database, assetId: string) {
  const rows = await db.selectFrom("app.external_campaigns").select(["id", "external_id", "ministry_id", "objective"])
    .where("external_asset_id", "=", assetId).execute();
  return new Map(rows.map((r) => [r.external_id, r]));
}

async function upsertAdSets(run: Run, asset: AssetRow, items: RawAdSet[]) {
  const campaigns = await campaignMap(run.ctx.db, asset.id);
  const values = [];
  const seen = new Set<string>();
  for (const s of items) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    const campaign = s.campaign_id ? campaigns.get(s.campaign_id) : undefined;
    if (!campaign) { run.count("adSetsSkipped"); continue; }
    values.push({
      external_campaign_id: campaign.id, ministry_id: campaign.ministry_id, external_id: s.id, name: s.name ?? s.id,
      status: s.status ?? null, effective_status: s.effective_status ?? null, optimization_goal: s.optimization_goal ?? null,
      start_time: s.start_time ?? null, end_time: s.end_time ?? null, raw: toJson(s),
    });
  }
  if (values.length === 0) return;
  await run.ctx.db.insertInto("app.external_ad_sets").values(values)
    .onConflict((oc) => oc.column("external_id").doUpdateSet((eb) => ({
      external_campaign_id: eb.ref("excluded.external_campaign_id"), ministry_id: eb.ref("excluded.ministry_id"),
      name: eb.ref("excluded.name"), status: eb.ref("excluded.status"), effective_status: eb.ref("excluded.effective_status"),
      optimization_goal: eb.ref("excluded.optimization_goal"), start_time: eb.ref("excluded.start_time"),
      end_time: eb.ref("excluded.end_time"), raw: eb.ref("excluded.raw"),
    }))).execute();
  run.count("adSets", values.length);
}

async function upsertAds(run: Run, asset: AssetRow, items: RawAd[]) {
  const campaigns = await campaignMap(run.ctx.db, asset.id);
  const adSetRows = await run.ctx.db.selectFrom("app.external_ad_sets as s")
    .innerJoin("app.external_campaigns as c", "c.id", "s.external_campaign_id")
    .select(["s.id", "s.external_id"]).where("c.external_asset_id", "=", asset.id).execute();
  const adSets = new Map(adSetRows.map((r) => [r.external_id, r.id]));
  const values = [];
  const seen = new Set<string>();
  for (const a of items) {
    if (!a?.id || seen.has(a.id)) continue;
    seen.add(a.id);
    const campaign = a.campaign_id ? campaigns.get(a.campaign_id) : undefined;
    if (!campaign) { run.count("adsSkipped"); continue; }
    values.push({
      external_campaign_id: campaign.id, external_ad_set_id: (a.adset_id ? adSets.get(a.adset_id) : undefined) ?? null,
      ministry_id: campaign.ministry_id, external_id: a.id, name: a.name ?? a.id, status: a.status ?? null,
      effective_status: a.effective_status ?? null, creative_thumbnail_url: a.creative?.thumbnail_url ?? null, raw: toJson(a),
    });
  }
  if (values.length === 0) return;
  await run.ctx.db.insertInto("app.external_ads").values(values)
    .onConflict((oc) => oc.column("external_id").doUpdateSet((eb) => ({
      external_campaign_id: eb.ref("excluded.external_campaign_id"), external_ad_set_id: eb.ref("excluded.external_ad_set_id"),
      ministry_id: eb.ref("excluded.ministry_id"), name: eb.ref("excluded.name"), status: eb.ref("excluded.status"),
      effective_status: eb.ref("excluded.effective_status"), creative_thumbnail_url: eb.ref("excluded.creative_thumbnail_url"),
      raw: eb.ref("excluded.raw"),
    }))).execute();
  run.count("ads", values.length);
}

interface EntityRef {
  id: string;
  ministry_id: string | null;
  objective: string | null;
}

/**
 * Remove observações derivadas de `actions` que a Meta deixou de informar
 * para um (entidade, dia) reenviado — revisão de atribuição. A Meta omite
 * tipos de ação sem ocorrências, então o valor anterior ficaria obsoleto.
 */
async function pruneRevisedActions(run: Run, entityType: "meta_campaign" | "meta_ad", pairs: Array<{ entityId: string; day: string }>, keep: string[]) {
  if (pairs.length === 0) return;
  await sql`
    delete from app.metric_observations o
    using unnest(${pairs.map((p) => p.entityId)}::uuid[], ${pairs.map((p) => p.day)}::date[]) as t(entity_id, day)
    where o.source = 'meta_ads' and o.entity_type = ${entityType} and o.granularity = 'day'
      and o.entity_id = t.entity_id and o.period_start = t.day and o.period_end = t.day
      and o.metric_key = any(${[...ACTION_DERIVED_METRICS]}::text[])
      and (o.metric_key || '|' || o.dimension_key || '|' || o.entity_id::text || '|' || o.period_start::text) <> all(${keep}::text[])
  `.execute(run.ctx.db);
}

async function writeDailyInsights(
  run: Run, asset: AssetRow, level: "campaign" | "ad", rows: InsightRow[], entities: Map<string, EntityRef>, currency: string | null,
) {
  const entityType = level === "campaign" ? "meta_campaign" : "meta_ad";
  const observations: ObservationInput[] = [];
  const pairs: Array<{ entityId: string; day: string }> = [];
  const keep: string[] = [];
  for (const row of rows) {
    const externalId = level === "campaign" ? row.campaign_id : row.ad_id;
    const entity = externalId ? entities.get(externalId) : undefined;
    const day = row.date_start;
    if (!entity || !day) { run.count("insightsSkipped"); continue; }
    pairs.push({ entityId: entity.id, day });
    for (const metric of insightRowToMetrics(row, entity.objective)) {
      observations.push({
        metricKey: metric.metricKey, dimensionKey: metric.dimensionKey, value: metric.value, source: "meta_ads",
        entityType, entityId: entity.id, granularity: "day", periodStart: day, periodEnd: day,
        ministryId: entity.ministry_id, currency, externalAssetId: asset.id,
      });
      if (ACTION_DERIVED_METRICS.includes(metric.metricKey)) keep.push(`${metric.metricKey}|${metric.dimensionKey}|${entity.id}|${day}`);
    }
  }
  await upsertObservations(run, observations);
  await pruneRevisedActions(run, entityType, pairs, keep);
}

async function syncAdAccount(run: Run, client: MetaClient, asset: AssetRow, state: AssetState, cls: ClassificationContext) {
  const metadata = asObject(asset.metadata);
  const currency = typeof metadata.currency === "string" ? metadata.currency : null;
  const act = asset.external_id;
  const since = state.since!;
  const until = state.until!;
  const chunks = splitRange(since, until, INSIGHTS_CHUNK_DAYS);

  const dailyInsights = (level: "campaign" | "ad") => async () => {
    const entities = new Map<string, EntityRef>();
    if (level === "campaign") {
      for (const [ext, c] of await campaignMap(run.ctx.db, asset.id)) entities.set(ext, c);
    } else {
      const rows = await run.ctx.db.selectFrom("app.external_ads as a").innerJoin("app.external_campaigns as c", "c.id", "a.external_campaign_id")
        .select(["a.id", "a.external_id", "a.ministry_id", "c.objective"]).where("c.external_asset_id", "=", asset.id).execute();
      for (const r of rows) entities.set(r.external_id, { id: r.id, ministry_id: r.ministry_id, objective: r.objective });
    }
    while (state.chunk < chunks.length) {
      const range = chunks[state.chunk]!;
      const result = await runPaged<InsightRow>(run, state,
        (cursor) => client.getPage<InsightRow>(`${act}/insights`, {
          level, time_increment: 1, time_range: JSON.stringify(range), fields: INSIGHT_FIELDS, limit: 500,
          use_unified_attribution_setting: true,
        }, cursor),
        (rows) => writeDailyInsights(run, asset, level, rows, entities, currency));
      if (result === "continue") return "continue";
      state.chunk++;
      state.cursor = null;
      await run.save();
    }
    return "done";
  };

  return runSteps(run, state, [
    () => runPaged<RawCampaign>(run, state,
      (cursor) => client.getPage<RawCampaign>(`${act}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200 }, cursor),
      (items) => upsertCampaigns(run, asset, items, cls)),
    () => runPaged<RawAdSet>(run, state,
      (cursor) => client.getPage<RawAdSet>(`${act}/adsets`, { fields: ADSET_FIELDS, limit: 200 }, cursor),
      (items) => upsertAdSets(run, asset, items)),
    () => runPaged<RawAd>(run, state,
      (cursor) => client.getPage<RawAd>(`${act}/ads`, { fields: AD_FIELDS, limit: 200 }, cursor),
      (items) => upsertAds(run, asset, items)),
    dailyInsights("campaign"),
    dailyInsights("ad"),
    // Alcance vitalício por campanha (não aditivo: não pode ser obtido somando dias).
    async () => {
      const campaigns = await campaignMap(run.ctx.db, asset.id);
      return runPaged<InsightRow>(run, state,
        (cursor) => client.getPage<InsightRow>(`${act}/insights`, {
          level: "campaign", date_preset: "maximum", fields: LIFETIME_FIELDS, limit: 500, use_unified_attribution_setting: true,
        }, cursor),
        async (rows) => {
          const observations: ObservationInput[] = [];
          for (const row of rows) {
            const campaign = row.campaign_id ? campaigns.get(row.campaign_id) : undefined;
            if (!campaign || !row.date_start || !row.date_stop) continue;
            for (const [field, metricKey] of [["reach", "reach"], ["impressions", "impressions"], ["spend", "spend"]] as const) {
              const value = toMetricNumber(row[field]);
              if (value === undefined) continue;
              observations.push({
                metricKey, value, source: "meta_ads", entityType: "meta_campaign", entityId: campaign.id, granularity: "lifetime",
                periodStart: row.date_start, periodEnd: row.date_stop, ministryId: campaign.ministry_id, currency, externalAssetId: asset.id,
              });
            }
          }
          await upsertObservations(run, observations);
        });
    },
  ]);
}

export const metaAdsHandler: JobHandler = async (ctx) => {
  const run = new Run(ctx, readProgress(ctx.job.progress));
  const assets = await enabledAssets(ctx.db, ctx.account.id, "meta_ad_account");
  if (assets.length === 0) return { status: "succeeded", stats: {}, message: "Nenhuma conta de anúncios habilitada para sincronização" };
  const cls = await loadClassificationContext(ctx.db, assets.map((a) => a.id));
  const client = userClient(ctx);
  const now = new Date();

  const result = await forEachAsset(run, assets,
    (asset) => {
      const metadata = asObject(asset.metadata);
      const today = todayInTimeZone(typeof metadata.timezone === "string" ? metadata.timezone : null, now);
      const backfilled = asObject(asset.sync_cursor).adsBackfilled === true;
      return { since: addDays(today, -((backfilled ? ADS_REFRESH_DAYS : ADS_BACKFILL_DAYS) - 1)), until: today };
    },
    async (asset, state) => {
      const r = await syncAdAccount(run, client, asset, state, cls);
      if (r === "done") await finishAssetCursor(ctx.db, asset, { adsBackfilled: true, adsLastWindow: { since: state.since, until: state.until } });
      return r;
    });
  if (result === "continue") return { status: "continue", stats: run.stats };
  return run.outcome(`Anúncios sincronizados: ${run.stats.campaigns ?? 0} campanha(s), ${run.stats.ads ?? 0} anúncio(s), ${run.stats.observations ?? 0} observação(ões)`);
};

// ---------------------------------------------------------------------
// Orgânico (Instagram / Facebook)
// ---------------------------------------------------------------------
interface RawMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
}

interface RawFbPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
}

interface PostInput {
  externalId: string;
  caption: string | null;
  mediaType: string | null;
  mediaProductType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  raw: unknown;
}

async function upsertPosts(run: Run, asset: AssetRow, platform: "instagram" | "facebook", posts: PostInput[], cls: Classification) {
  const unique = new Map(posts.map((p) => [p.externalId, p]));
  if (unique.size === 0) return new Map<string, { id: string; ministry_id: string | null }>();
  const rows = await run.ctx.db.insertInto("app.social_posts").values([...unique.values()].map((p) => ({
    external_asset_id: asset.id, platform, external_id: p.externalId, caption: p.caption, media_type: p.mediaType,
    media_product_type: p.mediaProductType, permalink: p.permalink, thumbnail_url: p.thumbnailUrl, published_at: p.publishedAt,
    raw: toJson(p.raw), ministry_id: cls.ministryId, classification: cls.classification, classification_reason: cls.reason,
    removed_in_source_at: null,
  }))).onConflict((oc) => oc.columns(["platform", "external_id"]).doUpdateSet((eb) => ({
    external_asset_id: eb.ref("excluded.external_asset_id"), caption: eb.ref("excluded.caption"),
    media_type: eb.ref("excluded.media_type"), media_product_type: eb.ref("excluded.media_product_type"),
    permalink: eb.ref("excluded.permalink"), thumbnail_url: eb.ref("excluded.thumbnail_url"),
    published_at: eb.ref("excluded.published_at"), raw: eb.ref("excluded.raw"), removed_in_source_at: null,
    ministry_id: sql<string | null>`case when ${sql.ref("social_posts.classification")} = 'manual' then ${sql.ref("social_posts.ministry_id")} else ${sql.ref("excluded.ministry_id")} end`,
    classification: sql<string>`case when ${sql.ref("social_posts.classification")} = 'manual' then 'manual' else ${sql.ref("excluded.classification")} end`,
    classification_reason: sql<string | null>`case when ${sql.ref("social_posts.classification")} = 'manual' then ${sql.ref("social_posts.classification_reason")} else ${sql.ref("excluded.classification_reason")} end`,
  }))).returning(["id", "external_id", "ministry_id"]).execute();
  run.count("posts", rows.length);
  return new Map(rows.map((r) => [r.external_id, { id: r.id, ministry_id: r.ministry_id }]));
}

const utcDate = (timestamp: string | undefined | null): string | null => {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) ? isoDate(new Date(ms)) : null;
};

const lifetimeObservation = (
  base: { source: "instagram" | "facebook"; entityId: string; publishedDay: string | null; today: string; ministryId: string | null; assetId: string },
  metricKey: string, value: number,
): ObservationInput => {
  const start = base.publishedDay && base.publishedDay <= base.today ? base.publishedDay : base.today;
  return {
    metricKey, value, source: base.source, entityType: "social_post", entityId: base.entityId, granularity: "lifetime",
    periodStart: start, periodEnd: base.today, ministryId: base.ministryId, externalAssetId: base.assetId,
  };
};

const snapshotObservation = (source: "instagram" | "facebook", asset: AssetRow, metricKey: string, value: number, day: string, ministryId: string | null): ObservationInput => ({
  metricKey, value, source, entityType: "external_asset", entityId: asset.id, granularity: "snapshot",
  periodStart: day, periodEnd: day, ministryId, externalAssetId: asset.id,
});

async function syncInstagram(run: Run, client: MetaClient, asset: AssetRow, state: AssetState, cls: ClassificationContext, today: string) {
  const assetClass = classifyByAsset(asset.id, cls.assetMinistries);
  const cutoff = addDays(today, -((asObject(asset.sync_cursor).organicBackfilled === true ? ORGANIC_REFRESH_DAYS : ORGANIC_BACKFILL_DAYS) - 1));
  const ig = asset.external_id;

  return runSteps(run, state, [
    async () => {
      const profile = await client.get<{ followers_count?: number; media_count?: number; username?: string }>(ig, { fields: "followers_count,media_count,username" });
      const followers = toMetricNumber(profile?.followers_count);
      if (followers !== undefined) await upsertObservations(run, [snapshotObservation("instagram", asset, "followers", followers, today, assetClass.ministryId)]);
      else await run.recordAvailability(asset.id, "account", "followers", false, "followers_count não retornado");
      run.didWork = true;
      return "done" as const;
    },
    async () => {
      // Alcance diário da conta (contas únicas por dia — não somar entre dias).
      const sinceDay = addDays(today, -ORGANIC_ACCOUNT_REACH_DAYS);
      try {
        const response = await client.get<InsightsResponse>(`${ig}/insights`, {
          metric: "reach", period: "day",
          since: Math.floor(Date.parse(`${sinceDay}T00:00:00Z`) / 1000), until: Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000),
        });
        const observations: ObservationInput[] = [];
        for (const item of response?.data ?? []) {
          if (item.name !== "reach") continue;
          for (const v of item.values ?? []) {
            const value = toMetricNumber(v.value);
            const end = v.end_time ? Date.parse(v.end_time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
            if (value === undefined || !Number.isFinite(end)) continue;
            // end_time marca o FIM do dia medido.
            const day = isoDate(new Date(end - DAY_MS));
            observations.push({
              metricKey: "reach", value, source: "instagram", entityType: "external_asset", entityId: asset.id, granularity: "day",
              periodStart: day, periodEnd: day, ministryId: assetClass.ministryId, externalAssetId: asset.id,
            });
          }
        }
        await upsertObservations(run, observations);
        await run.recordAvailability(asset.id, "account", "reach", true, null);
      } catch (error) {
        if (!isOptionalMetricError(error)) throw error;
        await run.recordAvailability(asset.id, "account", "reach", false, error.message);
      }
      run.didWork = true;
      return "done" as const;
    },
    () => runPaged<RawMedia>(run, state,
      (cursor) => client.getPage<RawMedia>(`${ig}/media`, {
        fields: "id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count", limit: 50,
      }, cursor),
      async (items) => {
        const recent = items.filter((m) => m?.id && (utcDate(m.timestamp) ?? today) >= cutoff);
        const stop = recent.length < items.length; // a lista vem da mais nova para a mais antiga
        const posts = await upsertPosts(run, asset, "instagram", recent.map((m) => ({
          externalId: m.id, caption: m.caption ?? null, mediaType: m.media_type ?? null, mediaProductType: m.media_product_type ?? null,
          permalink: m.permalink ?? null, thumbnailUrl: m.thumbnail_url ?? (m.media_type === "IMAGE" ? (m.media_url ?? null) : null),
          publishedAt: m.timestamp ?? null, raw: m,
        })), assetClass);
        for (const media of recent) {
          const post = posts.get(media.id);
          if (!post) continue;
          const base = { source: "instagram" as const, entityId: post.id, publishedDay: utcDate(media.timestamp), today, ministryId: post.ministry_id, assetId: asset.id };
          const observations: ObservationInput[] = [];
          const likes = toMetricNumber(media.like_count);
          if (likes !== undefined) observations.push(lifetimeObservation(base, "likes", likes));
          const comments = toMetricNumber(media.comments_count);
          if (comments !== undefined) observations.push(lifetimeObservation(base, "comments", comments));
          const scope = media.media_product_type ?? media.media_type ?? "default";
          const values = await collectOptionalInsights(run, client, media.id, INSTAGRAM_MEDIA_METRICS, { assetId: asset.id, scope });
          for (const [key, value] of values) observations.push(lifetimeObservation(base, key, value));
          await upsertObservations(run, observations);
        }
        return stop;
      }),
  ]);
}

async function syncFacebookPage(run: Run, ctx: JobContext, asset: AssetRow, state: AssetState, cls: ClassificationContext, today: string) {
  const token = ctx.credentials.pageTokens?.[asset.external_id];
  if (!token) {
    run.warn(`Token da Página "${asset.name}" ausente — execute a descoberta novamente`, { assetId: asset.id });
    return "done" as const;
  }
  const client = new MetaClient({ accessToken: token, version: ctx.graphVersion, appSecret: ctx.config.metaAppSecret, http: ctx.http });
  const assetClass = classifyByAsset(asset.id, cls.assetMinistries);
  const cutoff = addDays(today, -((asObject(asset.sync_cursor).organicBackfilled === true ? ORGANIC_REFRESH_DAYS : ORGANIC_BACKFILL_DAYS) - 1));
  const page = asset.external_id;

  try {
    return await runSteps(run, state, [
      async () => {
        const info = await client.get<{ followers_count?: number; fan_count?: number }>(page, { fields: "followers_count,fan_count" });
        const followers = toMetricNumber(info?.followers_count) ?? toMetricNumber(info?.fan_count);
        if (followers !== undefined) await upsertObservations(run, [snapshotObservation("facebook", asset, "followers", followers, today, assetClass.ministryId)]);
        run.didWork = true;
        return "done" as const;
      },
      () => runPaged<RawFbPost>(run, state,
        (cursor) => client.getPage<RawFbPost>(`${page}/posts`, {
          fields: "id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
          limit: 25,
        }, cursor),
        async (items) => {
          const recent = items.filter((p) => p?.id && (utcDate(p.created_time) ?? today) >= cutoff);
          const stop = recent.length < items.length;
          const posts = await upsertPosts(run, asset, "facebook", recent.map((p) => ({
            externalId: p.id, caption: p.message ?? null, mediaType: null, mediaProductType: null,
            permalink: p.permalink_url ?? null, thumbnailUrl: p.full_picture ?? null, publishedAt: p.created_time ?? null, raw: p,
          })), assetClass);
          for (const item of recent) {
            const post = posts.get(item.id);
            if (!post) continue;
            const base = { source: "facebook" as const, entityId: post.id, publishedDay: utcDate(item.created_time), today, ministryId: post.ministry_id, assetId: asset.id };
            const observations: ObservationInput[] = [];
            const likes = toMetricNumber(item.reactions?.summary?.total_count);
            if (likes !== undefined) observations.push(lifetimeObservation(base, "likes", likes));
            const comments = toMetricNumber(item.comments?.summary?.total_count);
            if (comments !== undefined) observations.push(lifetimeObservation(base, "comments", comments));
            // A Meta omite `shares` quando não há compartilhamentos: ausente ≠ 0, não gravamos.
            const shares = toMetricNumber(item.shares?.count);
            if (shares !== undefined) observations.push(lifetimeObservation(base, "shares", shares));
            const values = await collectOptionalInsights(run, client, item.id, FACEBOOK_POST_METRICS, { assetId: asset.id, scope: "facebook_post" });
            for (const [key, value] of values) observations.push(lifetimeObservation(base, key, value));
            await upsertObservations(run, observations);
          }
          return stop;
        }),
    ]);
  } catch (error) {
    // Token de Página inválido não invalida a conta inteira: avisa e segue.
    if (error instanceof IntegrationError && error.kind === "auth") {
      run.warn(`Token da Página "${asset.name}" inválido — execute a descoberta novamente`, { assetId: asset.id });
      return "done" as const;
    }
    throw error;
  }
}

export const metaOrganicHandler: JobHandler = async (ctx) => {
  const run = new Run(ctx, readProgress(ctx.job.progress));
  const instagram = await enabledAssets(ctx.db, ctx.account.id, "instagram_account");
  const pages = await enabledAssets(ctx.db, ctx.account.id, "facebook_page");
  const assets = [...instagram, ...pages];
  if (assets.length === 0) return { status: "succeeded", stats: {}, message: "Nenhuma conta orgânica habilitada para sincronização" };
  const cls = await loadClassificationContext(ctx.db, assets.map((a) => a.id));
  const client = userClient(ctx);
  const today = isoDate(new Date());

  const result = await forEachAsset(run, assets, () => ({}), async (asset, state) => {
    const r = asset.asset_type === "instagram_account"
      ? await syncInstagram(run, client, asset, state, cls, today)
      : await syncFacebookPage(run, ctx, asset, state, cls, today);
    if (r === "done") await finishAssetCursor(ctx.db, asset, { organicBackfilled: true, organicLastSyncDay: today });
    return r;
  });
  if (result === "continue") return { status: "continue", stats: run.stats };
  return run.outcome(`Orgânico sincronizado: ${run.stats.posts ?? 0} publicação(ões), ${run.stats.observations ?? 0} observação(ões)`);
};

export const metaHandlers: JobRegistry = {
  meta_discover: metaDiscoverHandler,
  meta_ads: metaAdsHandler,
  meta_organic: metaOrganicHandler,
};
