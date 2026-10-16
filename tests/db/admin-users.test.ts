/**
 * Área administrativa: gestão de usuários (RLS + sistema), convites,
 * sessões e dados de demonstração isolados do modo produção.
 *
 * Os serviços usam `systemDb()` (pool global configurado por env()), então o
 * ambiente aponta para o banco de testes ANTES da primeira chamada — env()
 * é validado de forma preguiçosa, na primeira conexão.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDbUrl, createTestDb, resetData } from "../support/db";
import { addMember, makeMinistry, makeUser } from "../support/fixtures";

process.env.DATABASE_URL = testDbUrl();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://insights.example.test";

const { systemDb, withUserDb } = await import("@/server/db");
const { acceptInvitation, login } = await import("@/server/auth/service");
const { createSession, validateSessionToken } = await import("@/server/auth/sessions");
const { ServiceError } = await import("@/server/services/context");
const users = await import("@/server/services/users");
const { loadDemoData, removeDemoData } = await import("@/server/services/demo");
const { getDashboard } = await import("@/server/services/analytics");
const { runJob, claimNextJob, enqueueJob } = await import("@/server/integrations/jobs");
const { enqueueDueJobs } = await import("@/server/integrations/scheduler");
const { addDays, todayIso } = await import("@/lib/period");
import type { Actor } from "@/server/auth/types";

const db = createTestDb();
const policy = { idleHours: 72, absoluteDays: 14 };

function actorOf(u: { id: string; email: string }, globalRole: Actor["globalRole"], agencyGlobalAccess: Actor["agencyGlobalAccess"] = "none"): Actor {
  return { userId: u.id, sessionId: "00000000-0000-0000-0000-000000000000", email: u.email, name: "Teste", globalRole, agencyGlobalAccess };
}

let admin: Actor;
let agencyGlobal: Actor;
let leader: { id: string; email: string };
let ministryA: { id: string; name: string };

beforeAll(async () => {
  await resetData(db);
  const a = await makeUser(db, { role: "superadmin", name: "Admin" });
  admin = actorOf(a, "superadmin");
  const g = await makeUser(db, { role: "agency", access: "manage" });
  agencyGlobal = actorOf(g, "agency", "manage");
  ministryA = await makeMinistry(db, "Ministério A");
  leader = await makeUser(db, { role: "ministry" });
  await addMember(db, leader.id, ministryA.id, "leader");
});

afterAll(async () => {
  await systemDb().destroy();
  await db.destroy();
});

describe("autorização do serviço de usuários", () => {
  it("o serviço usa o banco de testes", async () => {
    const row = await systemDb().selectFrom("app.users").select("id").where("id", "=", admin.userId).executeTakeFirst();
    expect(row?.id).toBe(admin.userId);
  });

  it("não superadmins recebem ServiceError forbidden em todas as funções", async () => {
    const leaderActor = actorOf(leader, "ministry");
    const calls: Array<(x: Actor) => Promise<unknown>> = [
      (x) => users.listUsers(x),
      (x) => users.getUser(x, leader.id),
      (x) => users.listInvitations(x),
      (x) => users.inviteUser(x, { email: "x@example.test", name: "Xis", globalRole: "agency" }),
      (x) => users.revokeInvitation(x, leader.id),
      (x) => users.createResetLink(x, leader.id),
      (x) => users.setUserStatus(x, leader.id, "disabled"),
      (x) => users.updateUserRole(x, leader.id, { globalRole: "agency" }),
      (x) => users.addMembership(x, { userId: leader.id, ministryId: ministryA.id, role: "leader" }),
      (x) => users.updateMembership(x, leader.id, { canViewInvestment: true }),
      (x) => users.removeMembership(x, leader.id),
      (x) => users.revokeSessions(x, leader.id),
      (x) => users.softDeleteUser(x, leader.id),
      (x) => users.membershipCandidates(x),
      (x) => loadDemoData(x),
      (x) => removeDemoData(x),
    ];
    for (const who of [agencyGlobal, leaderActor]) {
      for (const call of calls) {
        const err = await call(who).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as InstanceType<typeof ServiceError>).code).toBe("forbidden");
      }
    }
  });

  it("um token de sessão forjado com papel superadmin não passa pela RLS", async () => {
    // Mesmo que o Actor diga superadmin, a RLS consulta o papel real no banco.
    const fake = actorOf(leader, "superadmin");
    const result = await users.listUsers(fake);
    expect(result.rows.map((r) => r.id)).toEqual([leader.id]);
    await expect(users.setUserStatus(fake, admin.userId, "disabled")).rejects.toBeInstanceOf(ServiceError);
  });

  it("superadmin lista usuários com vínculos e não pode se desativar", async () => {
    const result = await users.listUsers(admin);
    const row = result.rows.find((r) => r.id === leader.id)!;
    expect(row.memberships).toHaveLength(1);
    expect(row.memberships[0]!.ministry_name).toBe("Ministério A");
    await expect(users.setUserStatus(admin, admin.userId, "disabled")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("sessões e vínculos", () => {
  it("desativar um usuário revoga as sessões", async () => {
    const u = await makeUser(db, { role: "ministry" });
    const s = await createSession(systemDb(), u.id, policy);
    expect(await validateSessionToken(systemDb(), s.token, policy)).not.toBeNull();
    await users.setUserStatus(admin, u.id, "disabled");
    expect(await validateSessionToken(systemDb(), s.token, policy)).toBeNull();
    const revoked = await db.selectFrom("app.sessions").select("revoked_at").where("user_id", "=", u.id).execute();
    expect(revoked.every((r) => r.revoked_at !== null)).toBe(true);
    // Reativar não ressuscita sessões antigas.
    await users.setUserStatus(admin, u.id, "active");
    expect(await validateSessionToken(systemDb(), s.token, policy)).toBeNull();
  });

  it("remover o vínculo revoga o acesso ao ministério", async () => {
    const u = await makeUser(db, { role: "ministry" });
    const membershipId = await users.addMembership(admin, { userId: u.id, ministryId: ministryA.id, role: "operational", canViewInvestment: false });
    const visible = () => withUserDb(u.id, (trx) => trx.selectFrom("app.ministries").select("id").execute(), db);
    expect((await visible()).map((m) => m.id)).toEqual([ministryA.id]);
    await users.updateMembership(admin, membershipId, { canViewInvestment: true });
    const m = await db.selectFrom("app.ministry_memberships").select("can_view_investment").where("id", "=", membershipId).executeTakeFirstOrThrow();
    expect(m.can_view_investment).toBe(true);
    await users.removeMembership(admin, membershipId);
    expect(await visible()).toEqual([]);
  });

  it("papel incompatível é recusado e mudar o papel global remove vínculos incompatíveis", async () => {
    const u = await makeUser(db, { role: "ministry" });
    await expect(users.addMembership(admin, { userId: u.id, ministryId: ministryA.id, role: "agency_manager" })).rejects.toMatchObject({ code: "invalid" });
    await users.addMembership(admin, { userId: u.id, ministryId: ministryA.id, role: "leader" });
    const r = await users.updateUserRole(admin, u.id, { globalRole: "agency", agencyGlobalAccess: "read" });
    expect(r.removedMemberships).toBe(1);
    const row = await db.selectFrom("app.users").select(["global_role", "agency_global_access"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ global_role: "agency", agency_global_access: "read" });
    await users.addMembership(admin, { userId: u.id, ministryId: ministryA.id, role: "agency_viewer" });
    expect((await users.updateUserRole(admin, u.id, { globalRole: "superadmin" })).removedMemberships).toBe(1);
  });

  it("exclusão lógica desativa, remove vínculos e encerra sessões", async () => {
    const u = await makeUser(db, { role: "ministry" });
    await users.addMembership(admin, { userId: u.id, ministryId: ministryA.id, role: "leader" });
    const s = await createSession(systemDb(), u.id, policy);
    await users.softDeleteUser(admin, u.id);
    expect(await validateSessionToken(systemDb(), s.token, policy)).toBeNull();
    const row = await db.selectFrom("app.users").select(["status", "deleted_at"]).where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("disabled");
    expect(row.deleted_at).not.toBeNull();
    expect(await db.selectFrom("app.ministry_memberships").select("id").where("user_id", "=", u.id).execute()).toEqual([]);
    expect((await users.listUsers(admin)).rows.some((r) => r.id === u.id)).toBe(false);
    const audit = await db.selectFrom("app.activity_logs").select(["action", "visibility"]).where("entity_id", "=", u.id).where("action", "=", "user_deleted").executeTakeFirst();
    expect(audit?.visibility).toBe("admin");
  });
});

describe("convites", () => {
  it("convite → aceite cria usuário + vínculo → login funciona", async () => {
    const { link } = await users.inviteUser(admin, {
      email: "Nova.Lider@Example.test", name: "Nova Líder", globalRole: "ministry", ministryId: ministryA.id, ministryRole: "leader", canViewInvestment: true,
    });
    expect(link).toMatch(/^https:\/\/insights\.example\.test\/convite\/[A-Za-z0-9_-]{40,}$/);
    const token = link.split("/convite/")[1]!;

    const pending = await users.listInvitations(admin, { status: "pending" });
    const inv = pending.find((i) => i.email === "nova.lider@example.test")!;
    expect(inv).toBeDefined();
    expect(Object.keys(inv)).not.toContain("token_hash");

    const accepted = await acceptInvitation(systemDb(), token, "Senha-forte-123", policy);
    const membership = await db.selectFrom("app.ministry_memberships").select(["role", "can_view_investment", "ministry_id"]).where("user_id", "=", accepted.userId).executeTakeFirstOrThrow();
    expect(membership).toEqual({ role: "leader", can_view_investment: true, ministry_id: ministryA.id });
    const session = await login(systemDb(), { email: "nova.lider@example.test", password: "Senha-forte-123", ip: "10.0.0.1" }, policy);
    expect((await validateSessionToken(systemDb(), session.token, policy))?.userId).toBe(accepted.userId);
    expect((await users.listInvitations(admin)).find((i) => i.id === inv.id)?.status).toBe("accepted");
    // Reuso do token é recusado.
    await expect(acceptInvitation(systemDb(), token, "Senha-forte-123", policy)).rejects.toThrow();
  });

  it("convite revogado não pode ser aceito; e-mail existente é recusado", async () => {
    const { id, link } = await users.inviteUser(admin, { email: "revogado@example.test", name: "Revogado", globalRole: "agency", agencyGlobalAccess: "read" });
    await users.revokeInvitation(admin, id);
    await expect(acceptInvitation(systemDb(), link.split("/convite/")[1]!, "Senha-forte-123", policy)).rejects.toThrow(/inválido ou expirado/);
    await expect(users.inviteUser(admin, { email: leader.email, name: "Dup", globalRole: "agency" })).rejects.toMatchObject({ code: "conflict" });
    await expect(users.inviteUser(admin, { email: "x@example.test", name: "Sem ministério", globalRole: "ministry" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("link de redefinição troca a senha e encerra sessões", async () => {
    const u = await makeUser(db, { role: "agency" });
    const s = await createSession(systemDb(), u.id, policy);
    const { link } = await users.createResetLink(admin, u.id);
    await acceptInvitation(systemDb(), link.split("/convite/")[1]!, "Outra-senha-456", policy);
    expect(await validateSessionToken(systemDb(), s.token, policy)).toBeNull();
    await expect(login(systemDb(), { email: u.email, password: "Outra-senha-456", ip: "10.0.0.2" }, policy)).resolves.toHaveProperty("token");
  });
});

describe("dados de demonstração", () => {
  const period = () => ({ start: addDays(todayIso(), -89), end: todayIso() });

  it("cria apenas ministérios is_demo e não aparece no modo produção", async () => {
    const before = await getDashboard(admin, { mode: "production", ...period() });
    const summary = await loadDemoData(admin);
    expect(summary.ministries).toBe(3);
    expect(summary.observations).toBeGreaterThan(1000);

    const created = await db.selectFrom("app.ministries").select(["name", "slug", "is_demo"]).where("slug", "like", "demo-%").execute();
    expect(created).toHaveLength(3);
    expect(created.every((m) => m.is_demo && m.name.startsWith("[DEMO]"))).toBe(true);
    // Toda métrica, campanha, publicação e tarefa criada pertence a ministério demo.
    const leaks = await db.selectFrom("app.metric_observations as o").innerJoin("app.ministries as m", "m.id", "o.ministry_id")
      .select((eb) => eb.fn.countAll<number>().as("n")).where("m.is_demo", "=", false).executeTakeFirstOrThrow();
    expect(Number(leaks.n)).toBe(0);
    const demoFlag = await db.selectFrom("app.metric_observations").select((eb) => eb.fn.countAll<number>().as("n")).where("is_demo", "=", false).executeTakeFirstOrThrow();
    expect(Number(demoFlag.n)).toBe(0);

    const production = await getDashboard(admin, { mode: "production", ...period() });
    expect(production.scope.ministryIds.sort()).toEqual(before.scope.ministryIds.sort());
    expect(production.communication.paid.impressions).toEqual(before.communication.paid.impressions);
    expect(production.operational).toEqual(before.operational);
    expect(production.byMinistry.some((m: { name?: string }) => m.name?.startsWith("[DEMO]"))).toBe(false);

    const demo = await getDashboard(admin, { mode: "demo", ...period() });
    expect(demo.scope.ministryIds).toHaveLength(3);
    const impressions = demo.communication.paid.impressions;
    expect(impressions.state).toBe("value");
    expect(impressions.state === "value" && impressions.value).toBeGreaterThan(0);
  });

  it("carregar duas vezes não duplica", async () => {
    await loadDemoData(admin);
    const ministries = await db.selectFrom("app.ministries").select("id").where("is_demo", "=", true).execute();
    expect(ministries).toHaveLength(3);
    const accounts = await db.selectFrom("app.connected_accounts").select(["id", "sync_enabled", "credentials_encrypted"]).where("label", "like", "[DEMO]%").execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ sync_enabled: false, credentials_encrypted: null });
  });

  it("o agendador ignora a conta fictícia e runJob cancela jobs para ela", async () => {
    const account = await db.selectFrom("app.connected_accounts").select("id").where("label", "like", "[DEMO]%").executeTakeFirstOrThrow();
    expect(await enqueueDueJobs(systemDb())).toBe(0);
    await enqueueJob(systemDb(), { accountId: account.id, provider: "meta", jobType: "meta_ads" });
    const job = (await claimNextJob(systemDb()))!;
    expect(job.connected_account_id).toBe(account.id);
    await runJob(systemDb(), job, { registry: { meta_ads: async () => ({ status: "succeeded" }) }, keys: { current: process.env.ENCRYPTION_KEY! } });
    const row = await db.selectFrom("app.sync_jobs").select("status").where("id", "=", job.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
    const acc = await db.selectFrom("app.connected_accounts").select("status").where("id", "=", account.id).executeTakeFirstOrThrow();
    expect(acc.status).toBe("connected");
  });

  it("removeDemoData limpa tudo", async () => {
    const r = await removeDemoData(admin);
    expect(r.ministries).toBe(3);
    expect(await db.selectFrom("app.ministries").select("id").where("is_demo", "=", true).execute()).toEqual([]);
    expect(await db.selectFrom("app.connected_accounts").select("id").where("label", "like", "[DEMO]%").execute()).toEqual([]);
    expect(await db.selectFrom("app.metric_observations").select("id").limit(1).execute()).toEqual([]);
    expect(await db.selectFrom("app.tasks").select("id").where("ministry_id", "is", null).execute()).toEqual([]);
    expect(await db.selectFrom("app.social_posts").select("id").limit(1).execute()).toEqual([]);
    const audit = await db.selectFrom("app.activity_logs").select("action").where("entity_type", "=", "demo_data").execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["demo_loaded", "demo_removed"]));
  });
});
