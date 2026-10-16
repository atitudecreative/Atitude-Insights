import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AsanaClient } from "@/server/integrations/asana/client";
import {
  buildAsanaAuthorizeUrl, createPkceChallenge, createPkceVerifier, exchangeAsanaCode, refreshAsanaToken,
} from "@/server/integrations/asana/oauth";
import { IntegrationError, type HttpDeps } from "@/server/integrations/http";

const TOKEN = "2/1234567890123/9876543210987:abcdefabcdefabcdefabcdef";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function makeDeps(handler: Handler) {
  const delays: number[] = [];
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const deps: HttpDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    }) as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
    now: () => Date.now(),
  };
  return { deps, delays, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("AsanaClient", () => {
  it("segue next_page.offset na paginação e envia limit=100", async () => {
    const { deps, calls } = makeDeps((url) => {
      const offset = url.searchParams.get("offset");
      if (!offset) return jsonResponse({ data: [{ gid: "1", name: "A" }], next_page: { offset: "o2", path: "/x", uri: "x" } });
      if (offset === "o2") return jsonResponse({ data: [{ gid: "2", name: "B" }], next_page: { offset: "o3" } });
      return jsonResponse({ data: [{ gid: "3", name: "C" }], next_page: null });
    });
    const client = new AsanaClient(TOKEN, deps);
    const projects = await client.listProjects("ws1");
    expect(projects.map((p) => p.gid)).toEqual(["1", "2", "3"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("100");
    expect(calls[0]!.url.searchParams.get("workspace")).toBe("ws1");
    expect(calls[0]!.url.searchParams.get("archived")).toBe("false");
    expect(calls[0]!.url.searchParams.get("opt_fields")).toBe("name,archived,color,permalink_url,team.name");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("listTasks devolve uma página por vez com nextOffset e repassa modified_since", async () => {
    const { deps, calls } = makeDeps(() => jsonResponse({ data: [{ gid: "t1", name: "T" }], next_page: { offset: "abc" } }));
    const page = await new AsanaClient(TOKEN, deps).listTasks({ projectGid: "p1", modifiedSince: "2026-01-01T00:00:00.000Z", offset: "prev" });
    expect(page).toEqual({ data: [{ gid: "t1", name: "T" }], nextOffset: "abc" });
    const url = calls[0]!.url;
    expect(url.pathname).toBe("/api/1.0/tasks");
    expect(url.searchParams.get("project")).toBe("p1");
    expect(url.searchParams.get("modified_since")).toBe("2026-01-01T00:00:00.000Z");
    expect(url.searchParams.get("offset")).toBe("prev");
    expect(url.searchParams.get("opt_fields")).toContain("memberships.section.gid");
    expect(url.searchParams.get("opt_fields")).toContain("custom_fields.multi_enum_values.name");
  });

  it("repete 429 respeitando o Retry-After", async () => {
    let n = 0;
    const { deps, delays } = makeDeps(() => {
      n++;
      if (n === 1) return jsonResponse({ errors: [{ message: "Too many requests" }] }, 429, { "Retry-After": "7" });
      return jsonResponse({ data: { gid: "u1", name: "Ana", email: "a@x", workspaces: [] } });
    });
    const me = await new AsanaClient(TOKEN, deps).getMe();
    expect(me.gid).toBe("u1");
    expect(delays).toEqual([7000]);
  });

  it("repete 5xx e depois conclui", async () => {
    let n = 0;
    const { deps, delays } = makeDeps(() => {
      n++;
      if (n <= 2) return jsonResponse({ errors: [{ message: "Server error" }] }, 503);
      return jsonResponse({ data: [], next_page: null });
    });
    const sections = await new AsanaClient(TOKEN, deps).listSections("p1");
    expect(sections).toEqual([]);
    expect(n).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("401 gera erro de autenticação sem repetição", async () => {
    let n = 0;
    const { deps, delays } = makeDeps(() => {
      n++;
      return jsonResponse({ errors: [{ message: `Not Authorized (token ${TOKEN})` }] }, 401);
    });
    const error = await new AsanaClient(TOKEN, deps).getMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).kind).toBe("auth");
    expect(n).toBe(1);
    expect(delays).toHaveLength(0);
    expect((error as IntegrationError).message).not.toContain(TOKEN);
  });

  it.each([
    [402, "permission"], [403, "permission"], [404, "not_found"], [400, "invalid_request"],
  ] as const)("HTTP %i → %s", async (status, kind) => {
    const { deps } = makeDeps(() => jsonResponse({ errors: [{ message: "falhou" }] }, status));
    const error = (await new AsanaClient(TOKEN, deps).getMe().catch((e: unknown) => e)) as IntegrationError;
    expect(error.kind).toBe(kind);
    expect(error.message).toContain("falhou");
  });

  it("erros de rede nunca expõem o token", async () => {
    const { deps } = makeDeps(() => { throw new Error(`connect failed Authorization: Bearer ${TOKEN}`); });
    const error = (await new AsanaClient(TOKEN, deps).getMe().catch((e: unknown) => e)) as IntegrationError;
    expect(error.kind).toBe("transient");
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("OAuth do Asana", () => {
  it("monta a URL de autorização com PKCE S256", () => {
    const verifier = createPkceVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    const challenge = createPkceChallenge(verifier);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(buildAsanaAuthorizeUrl({ clientId: "cid", redirectUri: "https://app.test/cb", state: "st", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://app.asana.com/-/oauth_authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://app.test/cb", response_type: "code", state: "st",
      code_challenge_method: "S256", code_challenge: challenge,
    });
  });

  it("troca o código e renova o token via formulário", async () => {
    const { deps, calls } = makeDeps(() => jsonResponse({ access_token: "new-at", refresh_token: "rt", expires_in: 3600, token_type: "bearer" }));
    const token = await exchangeAsanaCode({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/cb", code: "c0de", codeVerifier: "ver" }, deps);
    expect(token.access_token).toBe("new-at");
    const init = calls[0]!.init;
    expect(calls[0]!.url.href).toBe("https://app.asana.com/-/oauth_token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("ver");

    await refreshAsanaToken({ clientId: "cid", clientSecret: "sec", refreshToken: "rt" }, deps);
    const refreshForm = new URLSearchParams(calls[1]!.init.body as string);
    expect(refreshForm.get("grant_type")).toBe("refresh_token");
    expect(refreshForm.get("refresh_token")).toBe("rt");
  });

  it("invalid_grant vira erro de autenticação", async () => {
    const { deps } = makeDeps(() => jsonResponse({ error: "invalid_grant", error_description: "The code is invalid" }, 400));
    const error = (await refreshAsanaToken({ clientId: "c", clientSecret: "s", refreshToken: "r" }, deps).catch((e: unknown) => e)) as IntegrationError;
    expect(error.kind).toBe("auth");
  });
});
