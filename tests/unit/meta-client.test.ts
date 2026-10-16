import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HttpDeps } from "@/server/integrations/http";
import { appSecretProof, classifyMetaError, MetaClient } from "@/server/integrations/meta/client";
import {
  insightRowToMetrics, isConversionAction, resultActionType, toMetricNumber,
} from "@/server/integrations/meta/metrics";
import { buildMetaAuthorizeUrl, DEFAULT_META_SCOPES, debugToken } from "@/server/integrations/meta/oauth";

const TOKEN = "EAAtesttoken1234567890abcdefghijkl";

type Responder = (url: URL, init: RequestInit | undefined) => { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeHttp(responder: Responder) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const r = responder(url, init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) },
      });
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => Date.now(),
  };
  return { deps, calls, sleeps };
}

interface Failure { kind: string; message: string; retryAfterMs?: number }
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    return error as Failure;
  }
  throw new Error("Era esperada uma falha");
}

const metaError = (code: number, message = "erro", subcode?: number) => ({ error: { message, code, error_subcode: subcode, type: "OAuthException" } });

describe("classifyMetaError", () => {
  const h = new Headers();
  it("190 e 102 → auth", () => {
    expect(classifyMetaError(400, metaError(190), h).kind).toBe("auth");
    expect(classifyMetaError(400, metaError(102), h).kind).toBe("auth");
  });
  it("10, 200–299 e 3 → permission", () => {
    for (const code of [10, 200, 270, 299, 3]) expect(classifyMetaError(400, metaError(code), h).kind).toBe("permission");
  });
  it("4, 17, 32, 613, 80000–80014, subcódigo e HTTP 429 → rate_limit", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) expect(classifyMetaError(400, metaError(code), h).kind).toBe("rate_limit");
    expect(classifyMetaError(400, metaError(100, "x", 2446079), h).kind).toBe("rate_limit");
    expect(classifyMetaError(429, undefined, h).kind).toBe("rate_limit");
  });
  it("usa Retry-After / tempo estimado da Meta", () => {
    expect(classifyMetaError(429, undefined, new Headers({ "retry-after": "7" })).retryAfterMs).toBe(7000);
    const buc = new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "ads_insights", estimated_time_to_regain_access: 3 }] }) });
    expect(classifyMetaError(400, metaError(80000), buc).retryAfterMs).toBe(180_000);
  });
  it("1, 2 e 5xx → transient; 100 → invalid_request", () => {
    expect(classifyMetaError(500, metaError(1), h).kind).toBe("transient");
    expect(classifyMetaError(500, metaError(2), h).kind).toBe("transient");
    expect(classifyMetaError(503, undefined, h).kind).toBe("transient");
    const e = classifyMetaError(400, metaError(100, "(#100) metric[0] must be one of the following values"), h);
    expect(e.kind).toBe("invalid_request");
    expect(e.providerCode).toBe(100);
  });
});

describe("MetaClient", () => {
  it("envia o token no cabeçalho e o appsecret_proof correto", async () => {
    const { deps, calls } = fakeHttp(() => ({ body: { id: "1", name: "Usuário" } }));
    const client = new MetaClient({ accessToken: TOKEN, version: "v23.0", appSecret: "segredo", http: deps });
    await client.get("me", { fields: "id,name" });
    const call = calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe("https://graph.facebook.com/v23.0/me");
    expect(call.url.searchParams.get("fields")).toBe("id,name");
    expect(call.url.searchParams.get("access_token")).toBeNull();
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const expected = createHmac("sha256", "segredo").update(TOKEN).digest("hex");
    expect(appSecretProof(TOKEN, "segredo")).toBe(expected);
    expect(call.url.searchParams.get("appsecret_proof")).toBe(expected);
  });

  it("modo query envia access_token; sem app secret não envia proof", async () => {
    const { deps, calls } = fakeHttp(() => ({ body: {} }));
    await new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps, tokenIn: "query" }).get("me");
    expect(calls[0]!.url.searchParams.get("access_token")).toBe(TOKEN);
    expect(calls[0]!.url.searchParams.get("appsecret_proof")).toBeNull();
  });

  it("190 → auth sem repetição e mensagem sem o token", async () => {
    const { deps, calls } = fakeHttp(() => ({ status: 400, body: metaError(190, `Error validating access token: ${TOKEN} has expired`) }));
    const client = new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps });
    const error = await failure(client.get("me"));
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("190");
    expect(calls).toHaveLength(1);
  });

  it("token sem prefixo EAA também é removido da mensagem", async () => {
    const odd = "zzSECRETzzTOKENzz0001";
    const { deps } = fakeHttp(() => ({ status: 400, body: metaError(100, `Invalid param for ${odd}`) }));
    const error = await failure(new MetaClient({ accessToken: odd, version: "v23.0", http: deps }).get("me"));
    expect(error.message).not.toContain(odd);
  });

  it.each([4, 17, 613])("código %i → rate_limit repetido com backoff", async (code) => {
    let n = 0;
    const { deps, calls, sleeps } = fakeHttp(() => (n++ < 2 ? { status: 400, body: metaError(code) } : { body: { ok: true } }));
    const result = await new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps }).get<{ ok: boolean }>("act_1/insights");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("limite longo (tempo estimado > espera máxima) sobe para a fila com retryAfterMs", async () => {
    const { deps, calls } = fakeHttp(() => ({ status: 400, body: metaError(17), headers: { "retry-after": "600" } }));
    const error = await failure(new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps }).get("me"));
    expect(error.kind).toBe("rate_limit");
    expect(error.retryAfterMs).toBe(600_000);
    expect(calls).toHaveLength(1);
  });

  it("100 → invalid_request sem repetição", async () => {
    const { deps, calls } = fakeHttp(() => ({ status: 400, body: metaError(100, "Unsupported metric") }));
    const error = await failure(new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps }).get("1/insights"));
    expect(error.kind).toBe("invalid_request");
    expect(calls).toHaveLength(1);
  });

  it("5xx → transient repetido até o limite", async () => {
    const { deps, calls } = fakeHttp(() => ({ status: 502, body: undefined }));
    const error = await failure(new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps, maxAttempts: 3 }).get("me"));
    expect(error.kind).toBe("transient");
    expect(calls).toHaveLength(3);
  });

  it("paginação por cursor, página a página", async () => {
    const pages: Record<string, unknown> = {
      "": { data: [{ id: "1" }, { id: "2" }], paging: { cursors: { after: "C1" }, next: "https://graph.facebook.com/v23.0/act_1/campaigns?after=C1&access_token=XYZ" } },
      C1: { data: [{ id: "3" }], paging: { cursors: { after: "C2" }, next: "https://graph.facebook.com/v23.0/act_1/campaigns?after=C2" } },
      C2: { data: [{ id: "4" }], paging: { cursors: { after: "C3" } } },
    };
    const { deps, calls } = fakeHttp((url) => ({ body: pages[url.searchParams.get("after") ?? ""] }));
    const client = new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps });
    const first = await client.getPage<{ id: string }>("act_1/campaigns", { limit: 2 });
    expect(first.data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(first.next).toEqual({ after: "C1" });
    const second = await client.getPage<{ id: string }>("act_1/campaigns", { limit: 2 }, first.next);
    expect(second.next).toEqual({ after: "C2" });
    const all = await client.getAll<{ id: string }>("act_1/campaigns", { limit: 2 });
    expect(all.map((d) => d.id)).toEqual(["1", "2", "3", "4"]);
    expect(calls.every((c) => c.url.searchParams.get("access_token") === null)).toBe(true);
    expect(calls.every((c) => c.url.searchParams.get("limit") === "2")).toBe(true);
  });

  it("paginação sem cursors usa os parâmetros de paging.next (sem credenciais)", async () => {
    const { deps } = fakeHttp(() => ({ body: { data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v23.0/1/posts?until=1700000000&__paging_token=abc&access_token=SECRET" } } }));
    const page = await new MetaClient({ accessToken: TOKEN, version: "v23.0", http: deps }).getPage("1/posts");
    expect(page.next).toEqual({ until: "1700000000", __paging_token: "abc" });
  });
});

describe("OAuth", () => {
  it("URL de autorização contém state, escopos e redirect", () => {
    const url = new URL(buildMetaAuthorizeUrl({ appId: "123", redirectUri: "https://app.test/api/integrations/meta/callback", state: "st4te", version: "v23.0" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/api/integrations/meta/callback");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...DEFAULT_META_SCOPES]);
    expect(url.searchParams.get("scope")).toContain("instagram_manage_insights");
  });

  it("debugToken usa o token de app e interpreta a resposta", async () => {
    const { deps, calls } = fakeHttp(() => ({ body: { data: { is_valid: true, app_id: "123", user_id: "u1", scopes: ["ads_read"], expires_at: 0 } } }));
    const info = await debugToken({ appId: "123", appSecret: "s", inputToken: TOKEN }, "v23.0", deps);
    expect(calls[0]!.url.searchParams.get("access_token")).toBe("123|s");
    expect(info).toMatchObject({ isValid: true, scopes: ["ads_read"], expiresAt: null, userId: "u1" });
  });
});

describe("métricas de insights", () => {
  it("results conforme o objetivo (mapa explícito)", () => {
    expect(resultActionType("OUTCOME_TRAFFIC")).toBe("link_click");
    expect(resultActionType("OUTCOME_ENGAGEMENT")).toBe("post_engagement");
    expect(resultActionType("OUTCOME_LEADS")).toBe("lead");
    expect(resultActionType("OUTCOME_SALES")).toBe("offsite_conversion.fb_pixel_purchase");
    expect(resultActionType("VIDEO_VIEWS")).toBe("video_view");
    expect(resultActionType("OUTCOME_AWARENESS")).toBeNull();
    expect(resultActionType("CONVERSIONS")).toBeNull();
    expect(resultActionType(null)).toBeNull();
  });

  it("allowlist de conversões", () => {
    for (const t of ["lead", "purchase", "complete_registration", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"]) {
      expect(isConversionAction(t)).toBe(true);
    }
    for (const t of ["link_click", "post_engagement", "video_view", "page_engagement", "onsite_conversion.post_save"]) {
      expect(isConversionAction(t)).toBe(false);
    }
  });

  it("métrica ausente não vira 0; '0' da Meta vira 0", () => {
    expect(toMetricNumber(undefined)).toBeUndefined();
    expect(toMetricNumber("")).toBeUndefined();
    expect(toMetricNumber("abc")).toBeUndefined();
    expect(toMetricNumber("0")).toBe(0);
    const metrics = insightRowToMetrics({ date_start: "2026-10-01", spend: "0", impressions: "120" }, "OUTCOME_TRAFFIC");
    const keys = metrics.map((m) => m.metricKey);
    expect(keys).toEqual(["spend", "impressions"]);
    expect(metrics.find((m) => m.metricKey === "spend")?.value).toBe(0);
    expect(keys).not.toContain("reach");
    expect(keys).not.toContain("results");
  });

  it("extrai link_clicks, video_views, conversões, valores e resultados", () => {
    const metrics = insightRowToMetrics({
      date_start: "2026-10-01", inline_link_clicks: "40", clicks: "55",
      actions: [
        { action_type: "link_click", value: "40" }, { action_type: "video_view", value: "300" },
        { action_type: "lead", value: "5" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "3" },
        { action_type: "post_engagement", value: "90" },
      ],
      action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "199.90" }, { action_type: "link_click", value: "1" }],
    }, "OUTCOME_LEADS");
    const get = (k: string, d = "") => metrics.find((m) => m.metricKey === k && m.dimensionKey === d)?.value;
    expect(get("link_clicks")).toBe(40);
    expect(get("clicks")).toBe(55);
    expect(get("video_views")).toBe(300);
    expect(get("conversions", "lead")).toBe(5);
    expect(get("conversions", "offsite_conversion.fb_pixel_lead")).toBe(3);
    expect(get("conversions", "post_engagement")).toBeUndefined();
    expect(get("conversion_value", "offsite_conversion.fb_pixel_purchase")).toBeCloseTo(199.9);
    expect(get("conversion_value", "link_click")).toBeUndefined();
    expect(get("results", "lead")).toBe(5);
    expect(metrics.filter((m) => m.metricKey === "results")).toHaveLength(1);
  });
});
