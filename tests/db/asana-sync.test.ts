/**
 * Sincronização do Asana contra um PostgreSQL real, com um Asana falso em
 * memória (roteado por URL) injetado via HttpDeps.fetch.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadCredentials, type KeyRing } from "@/server/integrations/credentials";
import { IntegrationError, type HttpDeps } from "@/server/integrations/http";
import { claimNextJob, enqueueJob, processQueue, runJob, type JobType } from "@/server/integrations/jobs";
import type { AsanaProject, AsanaTask } from "@/server/integrations/asana/client";
import { completeAsanaOAuth, connectAsanaWithToken, testAsanaConnection } from "@/server/integrations/asana/service";
import { asanaHandlers } from "@/server/integrations/asana/sync";
import { createTestDb, resetData } from "../support/db";
import { makeCampaign, makeMinistry } from "../support/fixtures";

const db = createTestDb();
const keys: KeyRing = { current: randomBytes(32).toString("base64") };
const VALID = "1/1201234567890:validtokenvalidtoken0001";
const OLD = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------
// Asana falso
// ---------------------------------------------------------------------

interface Failure { match: RegExp; status: number; headers?: Record<string, string>; times: number }

class FakeAsana {
  tokens = new Set([VALID]);
  workspaces = [{ gid: "w1", name: "Igreja Atitude" }];
  projects = new Map<string, AsanaProject[]>([["w1", [
    { gid: "p1", name: "Kids", archived: false, permalink_url: "https://app.asana.com/0/p1", team: { name: "Comunicação" } },
    { gid: "p2", name: "Mulheres", archived: false, permalink_url: "https://app.asana.com/0/p2", team: { name: "Comunicação" } },
  ]]]);
  tasks = new Map<string, AsanaTask>();
  missingProjects = new Set<string>();
  failures: Failure[] = [];
  pageSize = 100;
  requests: URL[] = [];
  delays: number[] = [];
  /** OAuth: código válido → tokens emitidos. */
  oauthCodes = new Map<string, { access: string; refresh: string }>();
  refreshTokens = new Map<string, string>();

  deps: HttpDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => this.handle(
      new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), init ?? {},
    )) as typeof fetch,
    sleep: async (ms) => { this.delays.push(ms); },
    now: () => Date.now(),
  };

  addTask(gid: string, projectGid: string, opts: Partial<AsanaTask> & { sectionGid?: string; sectionName?: string; alsoIn?: string[] } = {}) {
    const { sectionGid, sectionName, alsoIn, ...rest } = opts;
    const memberships = [projectGid, ...(alsoIn ?? [])].map((p, i) => ({
      project: { gid: p, name: `Projeto ${p}` },
      section: i === 0 && sectionGid ? { gid: sectionGid, name: sectionName ?? `Seção ${sectionGid}` } : { gid: `${p}-untitled`, name: "Sem seção" },
    }));
    this.tasks.set(gid, {
      gid, name: `Tarefa ${gid}`, notes: "", completed: false, completed_at: null, due_on: "2026-11-01", due_at: null, start_on: null,
      created_at: OLD, modified_at: OLD, permalink_url: `https://app.asana.com/0/${projectGid}/${gid}`,
      assignee: { gid: "u9", name: "Bia" }, tags: [], memberships, custom_fields: [], ...rest,
    });
  }

  modify(gid: string, patch: Partial<AsanaTask>) {
    const task = this.tasks.get(gid)!;
    this.tasks.set(gid, { ...task, ...patch, modified_at: new Date().toISOString() });
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  private page<T>(items: T[], url: URL) {
    const start = Number(url.searchParams.get("offset") ?? "0");
    const data = items.slice(start, start + this.pageSize);
    const next = start + this.pageSize < items.length ? String(start + this.pageSize) : null;
    return this.json({ data, next_page: next ? { offset: next, path: url.pathname, uri: url.href } : null });
  }

  private handle(url: URL, init: RequestInit): Response {
    this.requests.push(url);
    const failure = this.failures.find((f) => f.times > 0 && f.match.test(url.href));
    if (failure) {
      failure.times--;
      return this.json({ errors: [{ message: "Simulated failure" }] }, failure.status, failure.headers);
    }
    if (url.pathname === "/-/oauth_token") return this.oauth(new URLSearchParams(String(init.body)));

    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? "";
    if (!this.tokens.has(auth.replace(/^Bearer /, ""))) return this.json({ errors: [{ message: "Not Authorized" }] }, 401);

    const path = url.pathname.replace(/^\/api\/1\.0/, "");
    if (path === "/users/me") {
      return this.json({ data: { gid: "u1", name: "Ana Admin", email: "ana@example.test", workspaces: this.workspaces } });
    }
    if (path === "/projects") return this.page(this.projects.get(url.searchParams.get("workspace") ?? "") ?? [], url);
    if (path === "/tasks") {
      const project = url.searchParams.get("project") ?? "";
      if (this.missingProjects.has(project)) return this.json({ errors: [{ message: "project: Unknown object" }] }, 404);
      const since = url.searchParams.get("modified_since");
      const items = [...this.tasks.values()]
        .filter((t) => t.memberships?.some((m) => m.project?.gid === project))
        .filter((t) => !since || (t.modified_at ?? "") >= since)
        .sort((a, b) => a.gid.localeCompare(b.gid));
      return this.page(items, url);
    }
    return this.json({ errors: [{ message: "Not found" }] }, 404);
  }

  private oauth(form: URLSearchParams): Response {
    if (form.get("grant_type") === "authorization_code") {
      const issued = this.oauthCodes.get(form.get("code") ?? "");
      if (!issued || !form.get("code_verifier")) return this.json({ error: "invalid_grant" }, 400);
      this.tokens.add(issued.access);
      this.refreshTokens.set(issued.refresh, issued.access);
      return this.json({ access_token: issued.access, refresh_token: issued.refresh, expires_in: 3600, token_type: "bearer", data: { gid: "u1", name: "Ana Admin" } });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!this.refreshTokens.has(form.get("refresh_token") ?? "")) return this.json({ error: "invalid_grant" }, 400);
      const access = `oauth-refreshed-${randomBytes(4).toString("hex")}`;
      this.tokens.add(access);
      return this.json({ access_token: access, expires_in: 3600, token_type: "bearer" });
    }
    return this.json({ error: "unsupported_grant_type" }, 400);
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

let fake: FakeAsana;

async function connect(): Promise<string> {
  const accountId = await connectAsanaWithToken(db, { label: "Asana Atitude", token: VALID, createdBy: null }, keys, fake.deps);
  await drain();
  return accountId;
}

async function drain() {
  return processQueue(db, { registry: asanaHandlers, keys, http: fake.deps, budgetMs: 20_000 });
}

async function assetId(gid: string) {
  return (await db.selectFrom("app.external_assets").select("id").where("external_id", "=", gid).executeTakeFirstOrThrow()).id;
}

async function enableProjects(...gids: string[]) {
  await db.updateTable("app.external_assets").set({ sync_enabled: true }).where("external_id", "in", gids).execute();
}

async function sync(accountId: string, jobType: JobType) {
  const { id } = await enqueueJob(db, { accountId, provider: "asana", jobType });
  await drain();
  return db.selectFrom("app.sync_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function task(gid: string) {
  return db.selectFrom("app.tasks").selectAll().where("source", "=", "asana").where("external_id", "=", gid).executeTakeFirstOrThrow();
}

const countTasks = async () => Number((await db.selectFrom("app.tasks").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

beforeEach(async () => {
  await resetData(db);
  fake = new FakeAsana();
});

// ---------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------

describe("conexão", () => {
  it("recusa token inválido e não grava nada", async () => {
    const error = await connectAsanaWithToken(db, { label: "X", token: "token-invalido-123456", createdBy: null }, keys, fake.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).kind).toBe("auth");
    expect((error as IntegrationError).message).not.toContain("token-invalido-123456");
    expect(await db.selectFrom("app.connected_accounts").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("app.sync_jobs").selectAll().execute()).toHaveLength(0);
  });

  it("grava credenciais cifradas e enfileira a descoberta", async () => {
    const accountId = await connectAsanaWithToken(db, { label: "Asana", token: VALID, createdBy: null }, keys, fake.deps);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ provider: "asana", auth_type: "personal_token", status: "connected", external_user_id: "u1", external_user_name: "Ana Admin", last_test_ok: true });
    expect(account.credentials_encrypted).toBeTruthy();
    expect(account.credentials_encrypted).not.toContain(VALID);
    expect(account.credentials_encrypted).not.toContain("validtoken");
    expect((await loadCredentials(db, accountId, keys))?.accessToken).toBe(VALID);
    const jobs = await db.selectFrom("app.sync_jobs").select(["job_type", "status"]).where("connected_account_id", "=", accountId).execute();
    expect(jobs).toEqual([{ job_type: "asana_discover", status: "queued" }]);
  });

  it("descobre workspaces e projetos (novos desabilitados) e marca removidos", async () => {
    const accountId = await connect();
    const assets = await db.selectFrom("app.external_assets").selectAll().where("connected_account_id", "=", accountId).orderBy("external_id").execute();
    expect(assets.map((a) => [a.asset_type, a.external_id, a.sync_enabled])).toEqual([
      ["asana_project", "p1", false], ["asana_project", "p2", false], ["asana_workspace", "w1", false],
    ]);
    const ws = assets.find((a) => a.external_id === "w1")!;
    expect(assets.find((a) => a.external_id === "p1")).toMatchObject({ parent_asset_id: ws.id, metadata: { archived: false, team: "Comunicação", permalink_url: "https://app.asana.com/0/p1" } });

    await enableProjects("p1");
    fake.projects.set("w1", fake.projects.get("w1")!.filter((p) => p.gid !== "p2"));
    await sync(accountId, "asana_discover");
    const after = await db.selectFrom("app.external_assets").select(["external_id", "sync_enabled", "removed_at"]).where("asset_type", "=", "asana_project").orderBy("external_id").execute();
    expect(after[0]).toMatchObject({ external_id: "p1", sync_enabled: true, removed_at: null });
    expect(after[1]!.removed_at).not.toBeNull();

    fake.projects.get("w1")!.push({ gid: "p2", name: "Mulheres" });
    await sync(accountId, "asana_discover");
    const p2 = await db.selectFrom("app.external_assets").select(["removed_at", "sync_enabled"]).where("external_id", "=", "p2").executeTakeFirstOrThrow();
    expect(p2).toEqual({ removed_at: null, sync_enabled: false });
    expect(await db.selectFrom("app.external_assets").selectAll().execute()).toHaveLength(3);
  });

  it("testa a conexão e marca 'expired' em token revogado", async () => {
    const accountId = await connect();
    expect((await testAsanaConnection(db, accountId, keys, {}, fake.deps)).ok).toBe(true);
    fake.tokens.clear();
    const result = await testAsanaConnection(db, accountId, keys, {}, fake.deps);
    expect(result.ok).toBe(false);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ status: "expired", last_test_ok: false });
  });

  it("OAuth: conclui o fluxo e renova o token uma vez em 401", async () => {
    fake.oauthCodes.set("good-code", { access: "oauth-access-1", refresh: "oauth-refresh-1" });
    const config = { asanaClientId: "cid", asanaClientSecret: "csecret" };
    await expect(completeAsanaOAuth(db, { code: "bad", codeVerifier: "v", redirectUri: "https://app.test/cb", label: "OAuth", createdBy: null }, keys, config, fake.deps))
      .rejects.toBeInstanceOf(IntegrationError);
    const accountId = await completeAsanaOAuth(db, { code: "good-code", codeVerifier: "v", redirectUri: "https://app.test/cb", label: "OAuth", createdBy: null }, keys, config, fake.deps);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.auth_type).toBe("oauth");
    expect(account.token_expires_at).not.toBeNull();
    expect(await loadCredentials(db, accountId, keys)).toEqual({ accessToken: "oauth-access-1", refreshToken: "oauth-refresh-1" });

    fake.tokens.delete("oauth-access-1"); // expirou
    const result = await testAsanaConnection(db, accountId, keys, config, fake.deps);
    expect(result.ok).toBe(true);
    const creds = await loadCredentials(db, accountId, keys);
    expect(creds?.accessToken).toMatch(/^oauth-refreshed-/);
    expect(creds?.refreshToken).toBe("oauth-refresh-1");
  });
});

describe("sincronização de tarefas", () => {
  it("importação inicial cria tarefas; reexecução não duplica", async () => {
    const accountId = await connect();
    await enableProjects("p1", "p2");
    fake.addTask("t1", "p1", { sectionGid: "s1", sectionName: "A fazer", tags: [{ gid: "g1", name: "urgente" }], alsoIn: ["p2"] });
    fake.addTask("t2", "p1", { completed: true, completed_at: "2026-02-01T10:00:00.000Z" });
    fake.addTask("t3", "p2", {
      custom_fields: [{ gid: "cf1", name: "Tipo", type: "enum", display_value: "Arte", enum_value: { gid: "opt1", name: "Arte" } }],
    });

    const job = await sync(accountId, "asana_incremental");
    expect(job.status).toBe("succeeded");
    expect(job.stats).toMatchObject({ tasks_created: 3, projects_synced: 2 });
    // t1 aparece nos dois projetos: atualizado na segunda listagem.
    expect((job.stats as Record<string, number>).tasks_updated).toBe(1);
    expect(await countTasks()).toBe(3);

    const t1 = await task("t1");
    expect(t1).toMatchObject({
      name: "Tarefa t1", completed: false, completed_at: null, assignee_name: "Bia", assignee_external_id: "u9", due_on: "2026-11-01",
      tags: ["urgente"], connected_account_id: accountId, removed_in_source_at: null, permalink_url: "https://app.asana.com/0/p1/t1",
    });
    expect(t1.projects).toEqual([{ gid: "p1", name: "Projeto p1" }, { gid: "p2", name: "Projeto p2" }]);
    const t3 = await task("t3");
    expect(t3.custom_fields).toEqual([{ gid: "cf1", name: "Tipo", type: "enum", display_value: "Arte", enum_option_gids: ["opt1"] }]);
    expect(t3.section_name).toBe("Sem seção");
    expect(t3.raw).toMatchObject({ gid: "t3" });

    const t2 = await task("t2");
    expect(t2.completed).toBe(true);
    expect(new Date(t2.completed_at!).toISOString()).toBe("2026-02-01T10:00:00.000Z");

    const cursor = await db.selectFrom("app.external_assets").select(["sync_cursor", "last_synced_at"]).where("external_id", "=", "p1").executeTakeFirstOrThrow();
    expect(typeof (cursor.sync_cursor as { modifiedSince?: unknown }).modifiedSince).toBe("string");
    expect(cursor.last_synced_at).not.toBeNull();

    const again = await sync(accountId, "asana_full");
    expect(again.status).toBe("succeeded");
    expect(again.stats).toMatchObject({ tasks_created: 0, tasks_removed: 0 });
    expect(await countTasks()).toBe(3);
  });

  it("incremental envia modified_since e atualiza apenas as modificadas", async () => {
    const accountId = await connect();
    await enableProjects("p1");
    fake.addTask("t1", "p1");
    fake.addTask("t2", "p1");
    await sync(accountId, "asana_incremental");
    const cursor = (await db.selectFrom("app.external_assets").select("sync_cursor").where("external_id", "=", "p1").executeTakeFirstOrThrow())
      .sync_cursor as { modifiedSince: string };
    // O cursor fica 2 minutos antes do início da sincronização.
    expect(Date.now() - new Date(cursor.modifiedSince).getTime()).toBeGreaterThanOrEqual(120_000);

    fake.modify("t2", { name: "Arte do culto", completed: true, completed_at: new Date().toISOString() });
    fake.requests = [];
    const job = await sync(accountId, "asana_incremental");
    const taskRequest = fake.requests.find((u) => u.pathname.endsWith("/tasks"))!;
    expect(taskRequest.searchParams.get("modified_since")).toBe(cursor.modifiedSince);
    expect(job.stats).toMatchObject({ tasks_created: 0, tasks_updated: 1 });
    expect(await task("t2")).toMatchObject({ name: "Arte do culto", completed: true });
    expect((await task("t1")).completed).toBe(false);
  });

  it("concluída somente quando completed=true (mesmo com completed_at presente)", async () => {
    const accountId = await connect();
    await enableProjects("p1");
    fake.addTask("t1", "p1", { completed: false, completed_at: "2026-02-01T10:00:00.000Z" });
    fake.addTask("t2", "p1", { completed: undefined });
    await sync(accountId, "asana_incremental");
    expect(await task("t1")).toMatchObject({ completed: false, completed_at: null });
    expect((await task("t2")).completed).toBe(false);
  });

  it("classifica por projeto, por seção, e deixa conflitos sem classificação", async () => {
    const A = await makeMinistry(db, "Kids");
    const B = await makeMinistry(db, "Mulheres");
    const campB = await makeCampaign(db, B.id);
    const accountId = await connect();
    await enableProjects("p1", "p2");
    const p1 = await assetId("p1");
    const p2 = await assetId("p2");
    await db.insertInto("app.asset_ministry_mappings").values({ external_asset_id: p1, ministry_id: A.id }).execute();
    await db.insertInto("app.mapping_rules").values([
      { provider: "asana", rule_type: "asana_section", external_asset_id: p2, match_value: "s-mulheres", ministry_id: B.id, campaign_id: campB.id },
      { provider: "asana", rule_type: "asana_tag", match_value: "g-x", ministry_id: A.id },
      { provider: "asana", rule_type: "asana_tag", match_value: "g-x", ministry_id: B.id },
    ]).execute();

    fake.addTask("t-proj", "p1");
    fake.addTask("t-sec", "p2", { sectionGid: "s-mulheres" });
    fake.addTask("t-conflict", "p2", { tags: [{ gid: "g-x", name: "x" }] });
    fake.addTask("t-none", "p2");
    const job = await sync(accountId, "asana_incremental");
    expect(job.status).toBe("succeeded");

    expect(await task("t-proj")).toMatchObject({ ministry_id: A.id, classification: "auto", campaign_id: null });
    expect(await task("t-sec")).toMatchObject({ ministry_id: B.id, classification: "auto", campaign_id: campB.id });
    const conflict = await task("t-conflict");
    expect(conflict).toMatchObject({ ministry_id: null, classification: "unclassified" });
    expect(conflict.classification_reason).toContain("conflitantes");
    expect(await task("t-none")).toMatchObject({ ministry_id: null, classification: "unclassified" });
    expect((job.stats as Record<string, number>).tasks_unclassified).toBe(2);
  });

  it("preserva classificação manual na ressincronização", async () => {
    const A = await makeMinistry(db, "Kids");
    const B = await makeMinistry(db, "Jovens");
    const accountId = await connect();
    await enableProjects("p1");
    await db.insertInto("app.asset_ministry_mappings").values({ external_asset_id: await assetId("p1"), ministry_id: A.id }).execute();
    fake.addTask("t1", "p1");
    await sync(accountId, "asana_incremental");
    expect((await task("t1")).ministry_id).toBe(A.id);

    await db.updateTable("app.tasks").set({ ministry_id: B.id, classification: "manual", classification_reason: "Revisão humana" })
      .where("external_id", "=", "t1").execute();
    fake.modify("t1", { name: "Renomeada" });
    await sync(accountId, "asana_full");
    expect(await task("t1")).toMatchObject({ name: "Renomeada", ministry_id: B.id, classification: "manual", classification_reason: "Revisão humana" });
  });

  it("full marca tarefas ausentes como removidas e restaura quando voltam", async () => {
    const accountId = await connect();
    await enableProjects("p1", "p2");
    fake.addTask("t1", "p1");
    fake.addTask("t2", "p1");
    fake.addTask("t3", "p2");
    await sync(accountId, "asana_incremental");

    const removedTask = fake.tasks.get("t2")!;
    fake.tasks.delete("t2");
    const job = await sync(accountId, "asana_full");
    expect(job.stats).toMatchObject({ tasks_removed: 1 });
    expect((await task("t2")).removed_in_source_at).not.toBeNull();
    expect((await task("t1")).removed_in_source_at).toBeNull();
    expect((await task("t3")).removed_in_source_at).toBeNull();

    fake.tasks.set("t2", removedTask);
    await sync(accountId, "asana_full");
    expect((await task("t2")).removed_in_source_at).toBeNull();
    expect(await countTasks()).toBe(3);
  });

  it("continua de onde parou quando o prazo é atingido", async () => {
    const accountId = await connect();
    await enableProjects("p1", "p2");
    fake.pageSize = 2;
    for (const gid of ["a1", "a2", "a3", "a4", "a5"]) fake.addTask(gid, "p1");
    fake.addTask("b1", "p2");

    const { id } = await enqueueJob(db, { accountId, provider: "asana", jobType: "asana_full" });
    const claimed = await claimNextJob(db);
    expect(claimed?.id).toBe(id);
    const first = await runJob(db, claimed!, { registry: asanaHandlers, keys, http: fake.deps, jobBudgetMs: -1_000 });
    expect(first.status).toBe("continue");
    const queued = await db.selectFrom("app.sync_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(queued.status).toBe("queued");
    expect(queued.progress).toMatchObject({ mode: "full", projectIndex: 0, offset: "2" });
    expect(await countTasks()).toBe(2);

    const second = await runJob(db, (await claimNextJob(db))!, { registry: asanaHandlers, keys, http: fake.deps, jobBudgetMs: 60_000 });
    expect(second.status).toBe("succeeded");
    const done = await db.selectFrom("app.sync_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(done.status).toBe("succeeded");
    expect(done.stats).toMatchObject({ tasks_created: 6, projects_synced: 2, tasks_removed: 0 });
    expect(await countTasks()).toBe(6);
  });

  it("404 em um projeto marca o ativo como removido e conclui como parcial", async () => {
    const accountId = await connect();
    await enableProjects("p1", "p2");
    fake.addTask("t1", "p1");
    fake.addTask("t2", "p2");
    fake.missingProjects.add("p1");
    const job = await sync(accountId, "asana_incremental");
    expect(job.status).toBe("partial");
    expect(job.stats).toMatchObject({ projects_synced: 1, projects_failed: 1, tasks_created: 1 });
    const p1 = await db.selectFrom("app.external_assets").select("removed_at").where("external_id", "=", "p1").executeTakeFirstOrThrow();
    expect(p1.removed_at).not.toBeNull();
    const logs = await db.selectFrom("app.sync_logs").select(["level", "message"]).where("sync_job_id", "=", job.id).execute();
    expect(logs.some((l) => l.level === "warn" && l.message.includes("Kids"))).toBe(true);
  });
});

describe("fila de jobs (ponta a ponta)", () => {
  it("processQueue executa o job, grava logs e last_successful_sync_at", async () => {
    const accountId = await connect();
    await enableProjects("p1");
    fake.addTask("t1", "p1");
    await enqueueJob(db, { accountId, provider: "asana", jobType: "asana_incremental" });
    const results = await drain();
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("succeeded");
    const job = await db.selectFrom("app.sync_jobs").selectAll().where("id", "=", results[0]!.jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe("succeeded");
    const logs = await db.selectFrom("app.sync_logs").select(["level", "message", "context"]).where("sync_job_id", "=", job.id).execute();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(VALID);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.status).toBe("connected");
    expect(account.last_successful_sync_at).not.toBeNull();
  });

  it("401 marca a conta como expirada e falha sem nova tentativa", async () => {
    const accountId = await connect();
    await enableProjects("p1");
    fake.tokens.clear();
    const job = await sync(accountId, "asana_incremental");
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    const account = await db.selectFrom("app.connected_accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    expect(account.status).toBe("expired");
    expect(account.last_error).toContain("Asana");
    expect(await db.selectFrom("app.sync_jobs").selectAll().where("status", "=", "queued").execute()).toHaveLength(0);
  });

  it("429 persistente agenda nova tentativa respeitando o Retry-After", async () => {
    const accountId = await connect();
    await enableProjects("p1");
    fake.addTask("t1", "p1");
    fake.failures.push({ match: /\/tasks\?/, status: 429, headers: { "Retry-After": "30" }, times: 100 });
    const before = Date.now();
    const job = await sync(accountId, "asana_incremental");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(new Date(job.run_after).getTime()).toBeGreaterThanOrEqual(before + 25_000);
    expect(fake.delays.filter((d) => d === 30_000).length).toBeGreaterThan(0);
    expect(job.progress).toMatchObject({ mode: "incremental", projectIndex: 0 });

    // Quando o limite passa, a nova tentativa conclui.
    fake.failures = [];
    await db.updateTable("app.sync_jobs").set({ run_after: new Date() }).where("id", "=", job.id).execute();
    await drain();
    const done = await db.selectFrom("app.sync_jobs").selectAll().where("id", "=", job.id).executeTakeFirstOrThrow();
    expect(done.status).toBe("succeeded");
    expect(await countTasks()).toBe(1);
  });
});
