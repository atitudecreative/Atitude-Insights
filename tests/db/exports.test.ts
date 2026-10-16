/**
 * Exportações e listagens operacionais: o caminho RLS (asUser) nunca expõe
 * registros de ministérios não autorizados — nem quando o filtro aponta
 * explicitamente para outro ministério — e métricas monetárias exigem
 * permissão de investimento.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/server/auth/types";
import { createTestDb, resetData, testDbUrl } from "../support/db";
import { addMember, addObservation, makeAsset, makeCampaign, makeConnectedAccount, makeEvent, makeExternalCampaign, makeMinistry, makeUser } from "../support/fixtures";

// systemDb() (usado por asUser) precisa apontar para o banco de testes ANTES de carregar os serviços.
process.env.DATABASE_URL = testDbUrl();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const db = createTestDb();
let services: {
  listTasks: typeof import("@/server/services/tasks").listTasks;
  listDeliverables: typeof import("@/server/services/deliverables").listDeliverables;
  listEvents: typeof import("@/server/services/events").listEvents;
  exp: typeof import("@/server/services/export");
  closeDb: () => Promise<void>;
};

let A: { id: string; name: string }, B: { id: string; name: string };
let leaderA: Actor, leaderAInvest: Actor, superadmin: Actor;

const actor = (u: { id: string; email: string }, globalRole: Actor["globalRole"] = "ministry"): Actor => ({
  userId: u.id, sessionId: "00000000-0000-0000-0000-000000000000", email: u.email, name: "Teste", globalRole, agencyGlobalAccess: "none",
});

beforeAll(async () => {
  const [tasks, deliverables, events, exp, dbmod] = await Promise.all([
    import("@/server/services/tasks"), import("@/server/services/deliverables"), import("@/server/services/events"),
    import("@/server/services/export"), import("@/server/db"),
  ]);
  services = { listTasks: tasks.listTasks, listDeliverables: deliverables.listDeliverables, listEvents: events.listEvents, exp, closeDb: () => dbmod.systemDb().destroy() };

  await resetData(db);
  A = await makeMinistry(db, "Ministério Alfa");
  B = await makeMinistry(db, "Ministério Beta");
  const uA = await makeUser(db, { role: "ministry" });
  const uAI = await makeUser(db, { role: "ministry" });
  const uS = await makeUser(db, { role: "superadmin" });
  await addMember(db, uA.id, A.id, "leader", false);
  await addMember(db, uAI.id, A.id, "leader", true);
  leaderA = actor(uA);
  leaderAInvest = actor(uAI);
  superadmin = actor(uS, "superadmin");

  const campA = await makeCampaign(db, A.id, "Campanha Alfa");
  const campB = await makeCampaign(db, B.id, "Campanha Beta");
  await makeEvent(db, A.id, "Evento Alfa");
  await makeEvent(db, B.id, "Evento Beta");
  await db.insertInto("app.tasks").values([
    { source: "manual", name: "Demanda Alfa", ministry_id: A.id, campaign_id: campA.id, classification: "manual" },
    { source: "manual", name: "=HYPERLINK(\"http://x\") Beta", ministry_id: B.id, campaign_id: campB.id, classification: "manual" },
  ]).execute();
  await db.insertInto("app.deliverables").values([
    { ministry_id: A.id, campaign_id: campA.id, title: "Arte Alfa", type: "arte" },
    { ministry_id: B.id, campaign_id: campB.id, title: "Arte Beta", type: "arte" },
  ]).execute();

  const account = await makeConnectedAccount(db, "meta");
  const asset = await makeAsset(db, account.id, "meta_ad_account");
  const extA = await makeExternalCampaign(db, asset.id, A.id);
  const extB = await makeExternalCampaign(db, asset.id, B.id);
  for (const day of ["2026-03-01", "2026-03-02"]) {
    await addObservation(db, { metric: "impressions", ministryId: A.id, entityId: extA.id, value: 1000, day });
    await addObservation(db, { metric: "spend", ministryId: A.id, entityId: extA.id, value: 10, day });
    await addObservation(db, { metric: "impressions", ministryId: B.id, entityId: extB.id, value: 50_000, day });
    await addObservation(db, { metric: "spend", ministryId: B.id, entityId: extB.id, value: 500, day });
  }
});

afterAll(async () => {
  await services?.closeDb();
  await db.destroy();
});

describe("listagens operacionais respeitam o escopo do usuário", () => {
  it("listTasks: apenas o ministério A, mesmo filtrando pelo ministério B", async () => {
    const all = await services.listTasks(leaderA, { mode: "production" });
    expect(all.rows.map((r) => r.name)).toEqual(["Demanda Alfa"]);
    const forced = await services.listTasks(leaderA, { mode: "production", ministryId: B.id });
    expect(forced.total).toBe(0);
    expect(forced.rows).toHaveLength(0);
  });

  it("listDeliverables: apenas o ministério A, mesmo filtrando pelo ministério B", async () => {
    const all = await services.listDeliverables(leaderA, { mode: "production" });
    expect(all.rows.map((r) => r.title)).toEqual(["Arte Alfa"]);
    expect((await services.listDeliverables(leaderA, { mode: "production", ministryId: B.id })).rows).toHaveLength(0);
  });

  it("listEvents: apenas o ministério A, mesmo filtrando pelo ministério B", async () => {
    const all = await services.listEvents(leaderA, { mode: "production", when: "all" });
    expect(all.rows.map((r) => r.name)).toEqual(["Evento Alfa"]);
    expect((await services.listEvents(leaderA, { mode: "production", when: "all", ministryId: B.id })).total).toBe(0);
  });

  it("modo demonstração não mistura dados reais", async () => {
    expect((await services.listTasks(superadmin, { mode: "demo" })).total).toBe(0);
  });

  it("superadmin vê os dois ministérios e o CSV neutraliza fórmulas", async () => {
    const res = await services.listTasks(superadmin, { mode: "production", pageSize: 500 });
    expect(res.total).toBe(2);
    const csv = services.exp.buildCsv(["Demanda", "Ministério"], res.rows.map((r) => [r.name, r.ministry_name]));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"") Beta";Ministério Beta`);
    expect(csv).not.toMatch(/(^|;|\n)=HYPERLINK/);
  });
});

describe("exportação de métricas diárias", () => {
  const f = { mode: "production" as const, start: "2026-03-01", end: "2026-03-31" };

  it("sem permissão de investimento: só métricas não monetárias do ministério A", async () => {
    const rows = await services.exp.metricsExportRows(leaderA, f);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.ministry_name))).toEqual(new Set(["Ministério Alfa"]));
    expect(rows.some((r) => r.metric_key === "spend" || r.is_monetary)).toBe(false);
  });

  it("com permissão de investimento: inclui investimento, mas nunca o ministério B", async () => {
    const rows = await services.exp.metricsExportRows(leaderAInvest, f);
    expect(rows.filter((r) => r.metric_key === "spend").map((r) => Number(r.value))).toEqual([10, 10]);
    expect(rows.some((r) => r.ministry_name === B.name)).toBe(false);
    const csv = services.exp.buildCsv(["Ministério", "Métrica", "Valor"], rows.map((r) => [r.ministry_name, r.metric_key, Number(r.value)]));
    expect(csv).not.toContain("Ministério Beta");
    expect(csv).not.toContain("50000");
  });

  it("filtro explícito pelo ministério B retorna vazio", async () => {
    expect(await services.exp.metricsExportRows(leaderAInvest, { ...f, ministryId: B.id })).toHaveLength(0);
  });

  it("superadmin exporta ambos; período inválido retorna vazio", async () => {
    const rows = await services.exp.metricsExportRows(superadmin, f);
    expect(new Set(rows.map((r) => r.ministry_name))).toEqual(new Set([A.name, B.name]));
    expect(await services.exp.metricsExportRows(superadmin, { ...f, start: "2026-13-01" })).toHaveLength(0);
  });

  it("registra a exportação na auditoria", async () => {
    await services.exp.logExport(leaderA, "metrics", { start: f.start }, 2);
    const log = await db.selectFrom("app.activity_logs").select(["action", "actor_user_id", "entity_type"]).where("action", "=", "exported").executeTakeFirst();
    expect(log).toMatchObject({ action: "exported", actor_user_id: leaderA.userId, entity_type: "metrics" });
  });
});
