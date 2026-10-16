/**
 * Sincronização da Meta contra uma Graph API falsa em memória (roteada pelo
 * caminho da URL), validando upserts, classificação, métricas, idempotência,
 * disponibilidade de métricas e tratamento de erros na fila de jobs.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadCredentials, saveCredentials } from "@/server/integrations/credentials";
import type { HttpDeps } from "@/server/integrations/http";
import { claimNextJob, enqueueJob, processQueue, runJob } from "@/server/integrations/jobs";
import { connectMetaWithToken, completeMetaOAuth, testMetaConnection } from "@/server/integrations/meta/service";
import { addDays, metaHandlers, todayInTimeZone } from "@/server/integrations/meta/sync";
import { createTestDb, resetData } from "../support/db";
import { makeMinistry, makeUser } from "../support/fixtures";

const db = createTestDb();
const keys = { current: randomBytes(32).toString("base64") };
const VERSION = "v23.0";
const USER_TOKEN = "EAAuserTOKENabcdefghijklmnopqrstuvwxyz0123";
const PAGE_TOKEN = "EAApageTOKENabcdefghijklmnopqrstuvwxyz0123";
const config = { metaAppId: "app-1", metaAppSecret: "app-secret" };

// ---------------------------------------------------------------------
// Graph API falsa
// ---------------------------------------------------------------------
interface FakeResponse { status?: number; body?: unknown; headers?: Record<string, string> }
type Route = (params: URLSearchParams, token: string | null) => FakeResponse | unknown;

class FakeGraph {
  routes = new Map<string, Route>();
  calls: Array<{ path: string; params: URLSearchParams; token: string | null }> = [];

  on(path: string, route: Route | unknown) {
    this.routes.set(path, typeof route === "function" ? (route as Route) : () => route);
    return this;
  }

  /** Rota paginada por cursor `after`. */
  paged(path: string, items: () => unknown[], pageSize = 2) {
    return this.on(path, (params: URLSearchParams) => {
      const all = items();
      const start = Number(params.get("after") ?? "0");
      const data = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return { data, paging: { cursors: { after: next ?? "end" }, ...(next ? { next: `https://graph.facebook.com/${VERSION}/${path}?after=${next}` } : {}) } };
    });
  }

  http: HttpDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(`/${VERSION}/`, "");
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const token = auth?.replace(/^Bearer /, "") ?? url.searchParams.get("access_token");
      this.calls.push({ path, params: url.searchParams, token });
      const route = this.routes.get(path);
      let result: FakeResponse;
      if (!route) result = { status: 404, body: { error: { message: `Rota falsa inexistente: ${path}`, code: 803 } } };
      else {
        const out = route(url.searchParams, token);
        result = out && typeof out === "object" && ("status" in out || "body" in out) ? (out as FakeResponse) : { body: out };
      }
      return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200, headers: { "content-type": "application/json", ...(result.headers ?? {}) } });
    }) as typeof fetch,
    sleep: async () => {},
    now: () => Date.now(),
  };

  callsTo(path: string) {
    return this.calls.filter((c) => c.path === path);
  }
}

const metaError = (code: number, message = "erro", status = 400): FakeResponse => ({ status, body: { error: { message, code, type: "OAuthException" } } });

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
async function makeMetaAccount(pageTokens?: Record<string, string>) {
  const row = await db.insertInto("app.connected_accounts").values({ provider: "meta", label: "Meta Atitude", auth_type: "oauth", status: "connected" })
    .returning("id").executeTakeFirstOrThrow();
  await saveCredentials(db, row.id, { accessToken: USER_TOKEN, pageTokens }, keys);
  return row.id;
}

async function makeAsset(accountId: string, type: "meta_ad_account" | "facebook_page" | "instagram_account", externalId: string, metadata: Record<string, unknown> = {}, enabled = true) {
  return (await db.insertInto("app.external_assets").values({
    connected_account_id: accountId, provider: "meta", asset_type: type, external_id: externalId, name: externalId,
    metadata: JSON.stringify(metadata), sync_enabled: enabled,
  }).returning("id").executeTakeFirstOrThrow()).id;
}

const runQueue = (graph: FakeGraph) =>
  processQueue(db, { registry: metaHandlers, keys, http: graph.http, graphVersion: VERSION, budgetMs: 60_000, config });

async function jobRow(id: string) {
  return db.selectFrom("app.sync_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function obs(where: { metric: string; entityId: string; day?: string; granularity?: string; dimension?: string; source?: string }) {
  let q = db.selectFrom("app.metric_observations").selectAll().where("metric_key", "=", where.metric).where("entity_id", "=", where.entityId)
    .where("granularity", "=", where.granularity ?? "day").where("dimension_key", "=", where.dimension ?? "");
  if (where.day) q = q.where("period_start", "=", where.day);
  if (where.source) q = q.where("source", "=", where.source);
  return q.execute();
}

const countObservations = async () => Number((await db.selectFrom("app.metric_observations").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db.destroy();
});

// ---------------------------------------------------------------------
// Descoberta
// ---------------------------------------------------------------------
describe("meta_discover", () => {
  it("cria ativos, guarda tokens de Página cifrados e marca removidos", async () => {
    const accountId = await makeMetaAccount();
    const stale = await makeAsset(accountId, "meta_ad_account", "act_999");
    const existingEnabled = await makeAsset(accountId, "meta_ad_account", "act_100", {}, true);

    let includeStale = false;
    const graph = new FakeGraph()
      .paged("me/adaccounts", () => [
        { id: "act_100", account_id: "100", name: "Conta Principal", account_status: 1, currency: "BRL", timezone_name: "America/Sao_Paulo" },
        { id: "act_200", account_id: "200", name: "Conta Kids", account_status: 1, currency: "USD", timezone_name: "America/New_York" },
        ...(includeStale ? [{ id: "act_999", name: "Antiga", currency: "BRL" }] : []),
      ])
      .paged("me/accounts", () => [
        { id: "page_1", name: "Atitude", access_token: PAGE_TOKEN, category: "Igreja", instagram_business_account: { id: "ig_1", username: "atitude", name: "Atitude" } },
        { id: "page_2", name: "Atitude Kids", access_token: "EAApage2TOKENabcdefghijklmnopqrstuvwxyz", category: "Igreja" },
      ]);

    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_discover" });
    await runQueue(graph);
    expect((await jobRow(job.id)).status).toBe("succeeded");

    const assets = await db.selectFrom("app.external_assets").selectAll().where("connected_account_id", "=", accountId).orderBy("external_id").execute();
    const byExt = new Map(assets.map((a) => [a.external_id, a]));
    expect([...byExt.keys()].sort()).toEqual(["act_100", "act_200", "act_999", "ig_1", "page_1", "page_2"]);
    expect(byExt.get("act_200")).toMatchObject({ asset_type: "meta_ad_account", sync_enabled: false, removed_at: null });
    expect(byExt.get("act_200")!.metadata).toMatchObject({ currency: "USD", timezone: "America/New_York", account_status: 1 });
    expect(byExt.get("act_100")!.id).toBe(existingEnabled);
    expect(byExt.get("act_100")!.sync_enabled).toBe(true); // nunca alterado em existentes
    expect(byExt.get("act_100")!.name).toBe("Conta Principal");
    expect(byExt.get("ig_1")).toMatchObject({ asset_type: "instagram_account", parent_asset_id: byExt.get("page_1")!.id, name: "@atitude" });
    expect(byExt.get("act_999")!.id).toBe(stale);
    expect(byExt.get("act_999")!.removed_at).not.toBeNull();

    // Tokens de Página cifrados (não aparecem em texto claro) e legíveis com a chave.
    const raw = await db.selectFrom("app.connected_accounts").select("credentials_encrypted").where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(raw.credentials_encrypted).not.toContain(PAGE_TOKEN);
    expect(raw.credentials_encrypted).not.toContain(USER_TOKEN);
    const creds = await loadCredentials(db, accountId, keys);
    expect(creds).toMatchObject({ accessToken: USER_TOKEN, pageTokens: { page_1: PAGE_TOKEN } });
    expect(graph.calls.every((c) => c.token === USER_TOKEN)).toBe(true);
    expect(graph.calls.every((c) => c.params.get("appsecret_proof"))).toBe(true);

    // Reaparecimento limpa removed_at.
    includeStale = true;
    await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_discover" });
    await runQueue(graph);
    const again = await db.selectFrom("app.external_assets").select("removed_at").where("id", "=", stale).executeTakeFirstOrThrow();
    expect(again.removed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Anúncios
// ---------------------------------------------------------------------
describe("meta_ads", () => {
  const today = todayInTimeZone("America/Sao_Paulo");
  const d1 = addDays(today, -2);
  const d2 = addDays(today, -1);

  function adsGraph(state: { spend: string; c2Actions: Array<{ action_type: string; value: string }> }) {
    const inRange = (params: URLSearchParams, day: string) => {
      const range = JSON.parse(params.get("time_range") ?? "{}") as { since: string; until: string };
      return day >= range.since && day <= range.until;
    };
    return new FakeGraph()
      .paged("act_100/campaigns", () => [
        { id: "c1", name: "Campanha Kids", objective: "OUTCOME_TRAFFIC", status: "ACTIVE", effective_status: "ACTIVE", start_time: "2026-07-01T10:00:00-0300", daily_budget: "5000", buying_type: "AUCTION" },
        { id: "c2", name: "[MUL] Encontro", objective: "OUTCOME_LEADS", status: "ACTIVE", effective_status: "ACTIVE", lifetime_budget: "100000" },
        { id: "c3", name: "Institucional", objective: "OUTCOME_AWARENESS", status: "PAUSED", effective_status: "PAUSED" },
      ])
      .paged("act_100/adsets", () => [
        { id: "s1", name: "Conjunto 1", campaign_id: "c1", status: "ACTIVE", optimization_goal: "LINK_CLICKS" },
        { id: "s2", name: "Conjunto 2", campaign_id: "c2", status: "ACTIVE", optimization_goal: "LEAD_GENERATION" },
        { id: "s3", name: "Conjunto 3", campaign_id: "c3", status: "PAUSED", optimization_goal: "REACH" },
      ])
      .paged("act_100/ads", () => [
        { id: "a1", name: "Anúncio 1", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", creative: { thumbnail_url: "https://cdn.test/a1.jpg" } },
        { id: "a2", name: "Anúncio 2", adset_id: "s2", campaign_id: "c2", status: "ACTIVE" },
      ])
      .on("act_100/insights", (params: URLSearchParams) => {
        if (params.get("date_preset") === "maximum") {
          return { data: [{ campaign_id: "c1", reach: "1500", impressions: "1050", spend: "10.50", date_start: "2026-07-01", date_stop: today }] };
        }
        const level = params.get("level");
        const rows = level === "campaign" ? [
          {
            campaign_id: "c1", date_start: d1, date_stop: d1, spend: state.spend, impressions: "1000", reach: "800", frequency: "1.25",
            clicks: "30", inline_link_clicks: "20", ctr: "3", cpc: "0.35", cpm: "10.5",
            actions: [{ action_type: "link_click", value: "20" }, { action_type: "video_view", value: "100" }],
          },
          // Dia sem alcance informado (ausente) e com investimento "0" explícito.
          { campaign_id: "c1", date_start: d2, date_stop: d2, spend: "0", impressions: "50" },
          { campaign_id: "c2", date_start: d1, date_stop: d1, spend: "5", impressions: "300", actions: state.c2Actions,
            action_values: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "0" }] },
          { campaign_id: "c3", date_start: d1, date_stop: d1, spend: "2", impressions: "900", reach: "850" },
        ] : [
          { campaign_id: "c1", ad_id: "a1", date_start: d1, date_stop: d1, spend: state.spend, impressions: "1000", actions: [{ action_type: "link_click", value: "20" }] },
          { campaign_id: "c2", ad_id: "a2", date_start: d1, date_stop: d1, spend: "5", impressions: "300", actions: state.c2Actions },
        ];
        return { data: rows.filter((r) => inRange(params, r.date_start)) };
      });
  }

  it("upsert de entidades, classificação, observações, idempotência e janela incremental", async () => {
    const A = await makeMinistry(db, "Atitude Kids");
    const B = await makeMinistry(db, "Mulheres");
    const accountId = await makeMetaAccount();
    const asset = await makeAsset(accountId, "meta_ad_account", "act_100", { currency: "BRL", timezone: "America/Sao_Paulo" });
    await db.insertInto("app.asset_ministry_mappings").values({ external_asset_id: asset, ministry_id: A.id }).execute();
    await db.insertInto("app.mapping_rules").values({ provider: "meta", rule_type: "meta_campaign_name_prefix", match_value: "[MUL]", ministry_id: B.id }).execute();
    // Classificação manual pré-existente deve ser preservada.
    await db.insertInto("app.external_campaigns").values({
      external_asset_id: asset, external_id: "c3", name: "Institucional (antigo)", ministry_id: B.id, classification: "manual", classification_reason: "Definido pela equipe",
    }).execute();

    const state = {
      spend: "10.50",
      c2Actions: [{ action_type: "lead", value: "4" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "2" }, { action_type: "link_click", value: "9" }],
    };
    const graph = adsGraph(state);
    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_ads" });
    await runQueue(graph);
    const row = await jobRow(job.id);
    expect(row.status).toBe("succeeded");
    expect(row.stats).toMatchObject({ campaigns: 3, adSets: 3, ads: 2 });

    // Janela de backfill: 90 dias.
    const firstWindow = graph.callsTo("act_100/insights").filter((c) => c.params.get("time_range")).map((c) => JSON.parse(c.params.get("time_range")!) as { since: string; until: string });
    expect(firstWindow[0]!.since).toBe(addDays(today, -89));
    expect(firstWindow.at(-1)!.until).toBe(today);
    expect(graph.callsTo("act_100/insights").every((c) => c.params.get("time_increment") === "1" || c.params.get("date_preset") === "maximum")).toBe(true);

    const campaigns = new Map((await db.selectFrom("app.external_campaigns").selectAll().where("external_asset_id", "=", asset).execute()).map((c) => [c.external_id, c]));
    expect(campaigns.get("c1")).toMatchObject({ ministry_id: A.id, classification: "auto", objective: "OUTCOME_TRAFFIC" });
    expect(campaigns.get("c2")).toMatchObject({ ministry_id: B.id, classification: "auto" });
    expect(campaigns.get("c2")!.classification_reason).toContain("[MUL]");
    expect(campaigns.get("c3")).toMatchObject({ ministry_id: B.id, classification: "manual", classification_reason: "Definido pela equipe", name: "Institucional" });
    expect(campaigns.get("c1")!.raw).toMatchObject({ daily_budget: "5000" });
    expect(new Date(campaigns.get("c1")!.start_time!).toISOString()).toBe("2026-07-01T13:00:00.000Z");

    const adSets = new Map((await db.selectFrom("app.external_ad_sets").selectAll().execute()).map((s) => [s.external_id, s]));
    expect(adSets.get("s1")).toMatchObject({ external_campaign_id: campaigns.get("c1")!.id, ministry_id: A.id, optimization_goal: "LINK_CLICKS" });
    expect(adSets.get("s3")!.ministry_id).toBe(B.id);
    const ads = new Map((await db.selectFrom("app.external_ads").selectAll().execute()).map((a) => [a.external_id, a]));
    expect(ads.get("a1")).toMatchObject({ external_ad_set_id: adSets.get("s1")!.id, ministry_id: A.id, creative_thumbnail_url: "https://cdn.test/a1.jpg" });
    expect(ads.get("a2")!.ministry_id).toBe(B.id);

    const c1 = campaigns.get("c1")!.id;
    const c2 = campaigns.get("c2")!.id;
    const c3 = campaigns.get("c3")!.id;
    const [spend] = await obs({ metric: "spend", entityId: c1, day: d1 });
    expect(spend).toMatchObject({
      value: 10.5, currency: "BRL", ministry_id: A.id, entity_type: "meta_campaign", source: "meta_ads", period_end: d1,
      connected_account_id: accountId, external_asset_id: asset, api_version: VERSION, is_monetary: true,
    });
    for (const [metric, value] of [["impressions", 1000], ["reach", 800], ["frequency", 1.25], ["clicks", 30], ["link_clicks", 20], ["ctr", 3], ["cpc", 0.35], ["cpm", 10.5], ["video_views", 100]] as const) {
      const rows = await obs({ metric, entityId: c1, day: d1 });
      expect(rows.map((r) => r.value), metric).toEqual([value]);
    }
    expect((await obs({ metric: "results", entityId: c1, day: d1, dimension: "link_click" }))[0]?.value).toBe(20);
    // "0" da Meta é gravado; ausência não vira zero.
    expect((await obs({ metric: "spend", entityId: c1, day: d2 }))[0]?.value).toBe(0);
    expect(await obs({ metric: "reach", entityId: c1, day: d2 })).toHaveLength(0);
    expect(await obs({ metric: "video_views", entityId: c1, day: d2 })).toHaveLength(0);
    // Conversões por action_type, valores e resultados do objetivo de leads.
    expect((await obs({ metric: "conversions", entityId: c2, day: d1, dimension: "lead" }))[0]).toMatchObject({ value: 4, ministry_id: B.id });
    expect((await obs({ metric: "conversions", entityId: c2, day: d1, dimension: "offsite_conversion.fb_pixel_lead" }))[0]?.value).toBe(2);
    expect(await obs({ metric: "conversions", entityId: c2, day: d1, dimension: "link_click" })).toHaveLength(0);
    expect((await obs({ metric: "conversion_value", entityId: c2, day: d1, dimension: "offsite_conversion.fb_pixel_lead" }))[0]?.value).toBe(0);
    expect((await obs({ metric: "results", entityId: c2, day: d1, dimension: "lead" }))[0]?.value).toBe(4);
    // Reconhecimento: sem mapeamento de resultado → nada gravado.
    const c3Results = await db.selectFrom("app.metric_observations").select("id").where("entity_id", "=", c3).where("metric_key", "=", "results").execute();
    expect(c3Results).toHaveLength(0);
    expect((await obs({ metric: "reach", entityId: c3, day: d1 }))[0]?.ministry_id).toBe(B.id);
    // Nível de anúncio usa o UUID local do anúncio.
    expect((await obs({ metric: "spend", entityId: ads.get("a1")!.id, day: d1 }))[0]).toMatchObject({ value: 10.5, entity_type: "meta_ad", ministry_id: A.id });
    // Alcance vitalício (não aditivo).
    const lifetime = await obs({ metric: "reach", entityId: c1, granularity: "lifetime" });
    expect(lifetime).toHaveLength(1);
    expect(lifetime[0]).toMatchObject({ value: 1500, period_start: "2026-07-01", period_end: today });

    const cursor = (await db.selectFrom("app.external_assets").select(["sync_cursor", "last_synced_at"]).where("id", "=", asset).executeTakeFirstOrThrow());
    expect(cursor.sync_cursor).toMatchObject({ adsBackfilled: true });
    expect(cursor.last_synced_at).not.toBeNull();

    // Reexecução: mesmos registros (sem duplicatas), valores atualizados e janela de 28 dias.
    const before = await countObservations();
    state.spend = "12";
    state.c2Actions = [{ action_type: "lead", value: "5" }, { action_type: "link_click", value: "9" }]; // pixel_lead revisado → some
    graph.calls = [];
    const job2 = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_ads" });
    await runQueue(graph);
    expect((await jobRow(job2.id)).status).toBe("succeeded");
    const secondWindow = graph.callsTo("act_100/insights").filter((c) => c.params.get("time_range")).map((c) => JSON.parse(c.params.get("time_range")!) as { since: string });
    expect(secondWindow[0]!.since).toBe(addDays(today, -27));
    // pixel_lead removido nos níveis de campanha e de anúncio.
    expect(await countObservations()).toBe(before - 2);
    expect((await obs({ metric: "spend", entityId: c1, day: d1 })).map((r) => r.value)).toEqual([12]);
    expect((await obs({ metric: "conversions", entityId: c2, day: d1, dimension: "lead" })).map((r) => r.value)).toEqual([5]);
    expect(await obs({ metric: "conversions", entityId: c2, day: d1, dimension: "offsite_conversion.fb_pixel_lead" })).toHaveLength(0);
    expect(await db.selectFrom("app.external_campaigns").select("id").execute()).toHaveLength(3);

    // Conta atualizada pela fila.
    const account = await db.selectFrom("app.connected_accounts").select(["status", "last_sync_at", "last_successful_sync_at"]).where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.status).toBe("connected");
    expect(account.last_sync_at).not.toBeNull();
    expect(account.last_successful_sync_at).not.toBeNull();
    const logs = await db.selectFrom("app.sync_logs").select(["message"]).where("sync_job_id", "=", job.id).execute();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.map((l) => l.message).join("\n")).not.toContain(USER_TOKEN);
  });

  it("retoma do checkpoint quando o prazo é atingido ('continue')", async () => {
    const accountId = await makeMetaAccount();
    await makeAsset(accountId, "meta_ad_account", "act_100", { currency: "BRL", timezone: "America/Sao_Paulo" });
    const graph = adsGraph({ spend: "1", c2Actions: [] });
    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_ads" });
    const statuses: string[] = [];
    for (let i = 0; i < 40; i++) {
      const claimed = await claimNextJob(db);
      if (!claimed) break;
      // Orçamento zero: cada execução processa uma página e devolve 'continue'.
      const outcome = await runJob(db, claimed, { registry: metaHandlers, keys, http: graph.http, graphVersion: VERSION, jobBudgetMs: 0, config });
      statuses.push(outcome.status);
    }
    expect(statuses.filter((s) => s === "continue").length).toBeGreaterThan(5);
    expect(statuses.at(-1)).toBe("succeeded");
    const row = await jobRow(job.id);
    expect(row.status).toBe("succeeded");
    expect(row.stats).toMatchObject({ campaigns: 3, adSets: 3, ads: 2 });
    // Cada página de campanhas foi buscada uma única vez.
    expect(graph.callsTo("act_100/campaigns")).toHaveLength(2);
    expect(await db.selectFrom("app.external_campaigns").select("id").execute()).toHaveLength(3);
  });

  it("erro 190 marca a conta como expirada e falha o job sem nova tentativa", async () => {
    const accountId = await makeMetaAccount();
    await makeAsset(accountId, "meta_ad_account", "act_100", { currency: "BRL" });
    const graph = new FakeGraph().on("act_100/campaigns", metaError(190, `Error validating access token for ${USER_TOKEN}`));
    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_ads" });
    await runQueue(graph);
    const row = await jobRow(job.id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error).not.toContain(USER_TOKEN);
    const account = await db.selectFrom("app.connected_accounts").select(["status", "last_error"]).where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.status).toBe("expired");
    expect(account.last_error).not.toContain(USER_TOKEN);
    expect(graph.callsTo("act_100/campaigns")).toHaveLength(1);
  });

  it("limite de taxa longo reagenda o job", async () => {
    const accountId = await makeMetaAccount();
    await makeAsset(accountId, "meta_ad_account", "act_100", { currency: "BRL" });
    const graph = new FakeGraph().on("act_100/campaigns", { ...metaError(17, "User request limit reached"), headers: { "retry-after": "600" } });
    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_ads" });
    const started = Date.now();
    await runQueue(graph);
    const row = await jobRow(job.id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(new Date(row.run_after).getTime()).toBeGreaterThanOrEqual(started + 590_000);
  });
});

// ---------------------------------------------------------------------
// Orgânico
// ---------------------------------------------------------------------
describe("meta_organic", () => {
  it("publicações, classificação, disponibilidade de métricas, seguidores e resultado parcial", async () => {
    const A = await makeMinistry(db, "Atitude Kids");
    const B = await makeMinistry(db, "Mulheres");
    const accountId = await makeMetaAccount({ page_1: PAGE_TOKEN });
    const ig = await makeAsset(accountId, "instagram_account", "ig_1");
    const page = await makeAsset(accountId, "facebook_page", "page_1");
    await makeAsset(accountId, "instagram_account", "ig_disabled", {}, false);
    await db.insertInto("app.asset_ministry_mappings").values([{ external_asset_id: ig, ministry_id: A.id }, { external_asset_id: page, ministry_id: A.id }]).execute();
    await db.insertInto("app.social_posts").values({
      external_asset_id: ig, platform: "instagram", external_id: "m2", ministry_id: B.id, classification: "manual", classification_reason: "Equipe",
    }).execute();

    const now = Date.now();
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+0000");
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = addDays(today, -1);
    let likes = 10;

    const igMetrics = (params: URLSearchParams, values: Record<string, number>, unsupported: string[] = []) => {
      const metrics = (params.get("metric") ?? "").split(",");
      if (metrics.some((m) => unsupported.includes(m))) return metaError(100, `(#100) metric ${unsupported.join(",")} is not supported for this media`);
      return { data: metrics.filter((m) => m in values).map((m) => ({ name: m, period: "lifetime", values: [{ value: values[m] }] })) };
    };

    const graph = new FakeGraph()
      .on("ig_1", { followers_count: 1234, media_count: 3, username: "atitude" })
      .on("ig_1/insights", { data: [{ name: "reach", period: "day", values: [{ value: 300, end_time: `${today}T07:00:00+0000` }, { value: 250, end_time: `${yesterday}T07:00:00+0000` }] }] })
      .paged("ig_1/media", () => [
        { id: "m1", caption: "Culto de domingo", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://instagram.com/p/m1", timestamp: iso(1), media_url: "https://cdn.test/m1.jpg", like_count: likes, comments_count: 3 },
        { id: "m2", caption: "Reel", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://instagram.com/r/m2", timestamp: iso(2), thumbnail_url: "https://cdn.test/m2.jpg", like_count: 40, comments_count: 0 },
        { id: "m3", caption: "Antigo", media_type: "IMAGE", media_product_type: "FEED", timestamp: iso(120), like_count: 1 },
      ])
      .on("m1/insights", (p: URLSearchParams) => igMetrics(p, { reach: 500, views: 900, likes, comments: 3, shares: 2, saved: 7, total_interactions: 22 }))
      .on("m2/insights", (p: URLSearchParams) => igMetrics(p, { reach: 2000, views: 5000, likes: 40, comments: 0, shares: 9, total_interactions: 49 }, ["saved"]))
      .on("page_1", (_p: URLSearchParams, token: string | null) => (token === PAGE_TOKEN ? { followers_count: 500, fan_count: 480 } : metaError(190)))
      .paged("page_1/posts", () => [
        { id: "page_1_p1", message: "Evento", created_time: iso(3), permalink_url: "https://facebook.com/p1", full_picture: "https://cdn.test/p1.jpg",
          shares: { count: 3 }, reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } } },
        { id: "page_1_p2", message: "Sem compartilhamentos", created_time: iso(4), reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } },
      ])
      .on("page_1_p1/insights", (p: URLSearchParams) => igMetrics(p, { post_impressions_unique: 900 }, ["post_media_view"]))
      .on("page_1_p2/insights", (p: URLSearchParams) => igMetrics(p, { post_impressions_unique: 15 }, ["post_media_view"]));

    const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_organic" });
    await runQueue(graph);
    const row = await jobRow(job.id);
    expect(row.status).toBe("partial");
    const account = await db.selectFrom("app.connected_accounts").select(["status", "last_error", "last_sync_at"]).where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.status).toBe("connected");
    expect(account.last_error).toContain("indisponível");
    expect(account.last_sync_at).not.toBeNull();

    const posts = new Map((await db.selectFrom("app.social_posts").selectAll().execute()).map((p) => [p.external_id, p]));
    expect([...posts.keys()].sort()).toEqual(["m1", "m2", "page_1_p1", "page_1_p2"]); // m3 fora da janela
    expect(posts.get("m1")).toMatchObject({ platform: "instagram", ministry_id: A.id, classification: "auto", media_product_type: "FEED", thumbnail_url: "https://cdn.test/m1.jpg" });
    expect(posts.get("m2")).toMatchObject({ ministry_id: B.id, classification: "manual", classification_reason: "Equipe", caption: "Reel" });
    expect(posts.get("page_1_p1")).toMatchObject({ platform: "facebook", ministry_id: A.id, caption: "Evento", permalink: "https://facebook.com/p1" });

    const m1 = posts.get("m1")!.id;
    const m2 = posts.get("m2")!.id;
    const p1 = posts.get("page_1_p1")!.id;
    const p2 = posts.get("page_1_p2")!.id;
    const life = async (metric: string, entityId: string) => (await obs({ metric, entityId, granularity: "lifetime" })).map((r) => [r.value, r.period_start, r.period_end, r.source]);
    expect(await life("saves", m1)).toEqual([[7, posts.get("m1")!.published_at!.toISOString().slice(0, 10), today, "instagram"]]);
    expect((await life("reach", m1))[0]?.[0]).toBe(500);
    expect((await life("views", m2))[0]?.[0]).toBe(5000);
    expect(await life("saves", m2)).toEqual([]);
    expect((await life("comments", m2))[0]?.[0]).toBe(0);
    expect((await obs({ metric: "views", entityId: m2, granularity: "lifetime" }))[0]?.ministry_id).toBe(B.id);

    const availability = await db.selectFrom("app.metric_availability").selectAll().where("external_asset_id", "=", ig).execute();
    const av = (metric: string, scope: string) => availability.find((a) => a.metric_key === metric && a.scope === scope);
    expect(av("saves", "REELS")).toMatchObject({ available: false });
    expect(av("saves", "REELS")!.reason).toContain("100");
    expect(av("views", "REELS")).toMatchObject({ available: true });
    expect(av("saves", "FEED")).toMatchObject({ available: true });
    expect(av("reach", "account")).toMatchObject({ available: true });

    // Seguidores (snapshot) e alcance diário da conta.
    const followers = await obs({ metric: "followers", entityId: ig, granularity: "snapshot" });
    expect(followers).toHaveLength(1);
    expect(followers[0]).toMatchObject({ value: 1234, entity_type: "external_asset", period_start: today, ministry_id: A.id, source: "instagram" });
    expect((await obs({ metric: "reach", entityId: ig, day: yesterday }))[0]?.value).toBe(300);
    expect((await obs({ metric: "followers", entityId: page, granularity: "snapshot" }))[0]).toMatchObject({ value: 500, source: "facebook" });

    // Facebook: resumo de reações/comentários/compartilhamentos e insights opcionais.
    expect((await life("likes", p1))[0]?.[0]).toBe(10);
    expect((await life("shares", p1))[0]?.[0]).toBe(3);
    expect(await life("shares", p2)).toEqual([]); // ausente ≠ 0
    expect((await life("likes", p2))[0]?.[0]).toBe(0);
    expect((await life("reach", p1))[0]?.[0]).toBe(900);
    expect(await life("views", p1)).toEqual([]);
    const fbAv = await db.selectFrom("app.metric_availability").selectAll().where("external_asset_id", "=", page).execute();
    expect(fbAv.find((a) => a.metric_key === "views")).toMatchObject({ available: false, scope: "facebook_post" });
    expect(fbAv.find((a) => a.metric_key === "reach")).toMatchObject({ available: true });
    expect(graph.calls.filter((c) => c.path.startsWith("page_1")).every((c) => c.token === PAGE_TOKEN)).toBe(true);
    // Métrica indisponível é pulada no restante do job (p2 não repete post_media_view).
    expect(graph.callsTo("page_1_p2/insights").map((c) => c.params.get("metric"))).toEqual(["post_impressions_unique"]);
    expect(graph.callsTo("ig_disabled")).toHaveLength(0);

    // Reexecução no mesmo dia: atualiza sem duplicar.
    const before = await countObservations();
    likes = 15;
    await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_organic" });
    await runQueue(graph);
    expect(await countObservations()).toBe(before);
    expect((await life("likes", m1))[0]?.[0]).toBe(15);
    expect(await db.selectFrom("app.social_posts").select("id").execute()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------
describe("conexão da Meta", () => {
  it("connectMetaWithToken recusa token inválido sem armazená-lo", async () => {
    const user = await makeUser(db, { role: "superadmin" });
    const graph = new FakeGraph().on("me", metaError(190, "Invalid OAuth access token"));
    await expect(connectMetaWithToken(db, { label: "BM", token: USER_TOKEN, createdBy: user.id }, keys, config, VERSION, graph.http))
      .rejects.toMatchObject({ kind: "auth" });
    expect(await db.selectFrom("app.connected_accounts").select("id").execute()).toHaveLength(0);

    // Válido em /me, mas o debug_token diz que é inválido.
    const graph2 = new FakeGraph().on("me", { id: "u1", name: "Sistema" }).on("debug_token", { data: { is_valid: false, app_id: "app-1" } });
    await expect(connectMetaWithToken(db, { label: "BM", token: USER_TOKEN, createdBy: user.id }, keys, config, VERSION, graph2.http))
      .rejects.toMatchObject({ kind: "auth" });
    expect(await db.selectFrom("app.connected_accounts").select("id").execute()).toHaveLength(0);
  });

  it("connectMetaWithToken válido grava credenciais cifradas e enfileira a descoberta", async () => {
    const user = await makeUser(db, { role: "superadmin" });
    const graph = new FakeGraph().on("me", { id: "u1", name: "Usuário do Sistema" })
      .on("debug_token", (p: URLSearchParams) => ({ data: { is_valid: p.get("access_token") === "app-1|app-secret", app_id: "app-1", scopes: ["ads_read", "pages_show_list"], expires_at: 0 } }));
    const result = await connectMetaWithToken(db, { label: "Business Manager", token: USER_TOKEN, createdBy: user.id }, keys, config, VERSION, graph.http);
    expect(result.expiresAt).toBeNull();
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", result.accountId).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ provider: "meta", auth_type: "personal_token", status: "connected", external_user_id: "u1", scopes: ["ads_read", "pages_show_list"], token_expires_at: null });
    expect(account.credentials_encrypted).not.toContain(USER_TOKEN);
    expect((await loadCredentials(db, result.accountId, keys))?.accessToken).toBe(USER_TOKEN);
    expect((await jobRow(result.jobId))).toMatchObject({ job_type: "meta_discover", status: "queued" });
  });

  it("completeMetaOAuth troca code → token longo e cria a conta", async () => {
    const user = await makeUser(db, { role: "superadmin" });
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 86_400;
    const graph = new FakeGraph()
      .on("oauth/access_token", (p: URLSearchParams) => (p.get("grant_type") === "fb_exchange_token"
        ? { access_token: USER_TOKEN, token_type: "bearer", expires_in: 5_184_000 }
        : p.get("code") === "CODE123" ? { access_token: "EAAshortTOKENabcdefghijklmnopqrstu", expires_in: 3600 } : metaError(100, "Invalid code")))
      .on("debug_token", { data: { is_valid: true, app_id: "app-1", user_id: "u9", scopes: ["ads_read", "instagram_basic"], expires_at: expiresAt } })
      .on("me", { id: "u9", name: "Fulano" });
    const result = await completeMetaOAuth(db, { code: "CODE123", redirectUri: "https://app.test/api/integrations/meta/callback", label: "Meta Atitude", createdBy: user.id }, keys, config, VERSION, graph.http);
    expect(result.daysRemaining).toBeGreaterThanOrEqual(59);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", result.accountId).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ auth_type: "oauth", external_user_name: "Fulano", scopes: ["ads_read", "instagram_basic"] });
    expect(new Date(account.token_expires_at!).getTime()).toBe(expiresAt * 1000);
    expect((await loadCredentials(db, result.accountId, keys))?.accessToken).toBe(USER_TOKEN);
  });

  it("testMetaConnection detecta token vencido e erro de autenticação", async () => {
    const accountId = await makeMetaAccount();
    await db.updateTable("app.connected_accounts").set({ token_expires_at: new Date(Date.now() - 86_400_000) }).where("id", "=", accountId).execute();
    const graph = new FakeGraph().on("me", { id: "u1", name: "X" });
    const expired = await testMetaConnection(db, accountId, keys, {}, VERSION, graph.http);
    expect(expired).toMatchObject({ ok: false, status: "expired" });
    expect(graph.calls).toHaveLength(0);

    await db.updateTable("app.connected_accounts").set({ token_expires_at: new Date(Date.now() + 5 * 86_400_000 - 3_600_000), status: "connected" }).where("id", "=", accountId).execute();
    const ok = await testMetaConnection(db, accountId, keys, {}, VERSION, graph.http);
    expect(ok).toMatchObject({ ok: true, status: "connected", daysRemaining: 4 });
    expect(ok.message).toContain("reconecte");

    const bad = new FakeGraph().on("me", metaError(190));
    const failed = await testMetaConnection(db, accountId, keys, {}, VERSION, bad.http);
    expect(failed).toMatchObject({ ok: false, status: "expired" });
    const account = await db.selectFrom("app.connected_accounts").select(["status", "last_test_ok", "last_tested_at"]).where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ status: "expired", last_test_ok: false });
  });
});
