/**
 * Critérios de aceitação de isolamento multiministério, verificados
 * diretamente no PostgreSQL com o papel restrito `atitude_app` (o mesmo
 * caminho usado por todas as consultas originadas por usuários).
 */
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserDb } from "@/server/db";
import { validateSessionToken, createSession, revokeAllUserSessions } from "@/server/auth/sessions";
import { createTestDb, resetData } from "../support/db";
import {
  addMember, addObservation, makeAsset, makeCampaign, makeConnectedAccount, makeEvent, makeExternalCampaign,
  makeMinistry, makeUser,
} from "../support/fixtures";

const db = createTestDb();
const as = <T,>(userId: string, fn: Parameters<typeof withUserDb<T>>[1]) => withUserDb<T>(userId, fn, db);

let A: { id: string }, B: { id: string };
let leaderA: { id: string }, leaderANoInvest: { id: string }, opA: { id: string }, agencyMgrA: { id: string };
let agencyGlobal: { id: string }, superadmin: { id: string };
let campA: { id: string }, campB: { id: string }, eventB: { id: string };
let extA: { id: string }, extB: { id: string };

beforeAll(async () => {
  await resetData(db);
  A = await makeMinistry(db, "Atitude Kids");
  B = await makeMinistry(db, "Mulheres");
  leaderA = await makeUser(db, { role: "ministry" });
  leaderANoInvest = await makeUser(db, { role: "ministry" });
  opA = await makeUser(db, { role: "ministry" });
  agencyMgrA = await makeUser(db, { role: "agency", access: "none" });
  agencyGlobal = await makeUser(db, { role: "agency", access: "read" });
  superadmin = await makeUser(db, { role: "superadmin" });
  await addMember(db, leaderA.id, A.id, "leader", true);
  await addMember(db, leaderANoInvest.id, A.id, "leader", false);
  await addMember(db, opA.id, A.id, "operational");
  await addMember(db, agencyMgrA.id, A.id, "agency_manager");

  campA = await makeCampaign(db, A.id, "Conferência Kids");
  campB = await makeCampaign(db, B.id, "Encontro de Mulheres");
  await makeEvent(db, A.id);
  eventB = await makeEvent(db, B.id);
  await db.insertInto("app.tasks").values([
    { source: "manual", name: "Arte A", ministry_id: A.id, campaign_id: campA.id, classification: "manual" },
    { source: "manual", name: "Arte B", ministry_id: B.id, campaign_id: campB.id, classification: "manual" },
    { source: "asana", external_id: "999", name: "Sem classificação", ministry_id: null, classification: "unclassified" },
  ]).execute();
  await db.insertInto("app.deliverables").values([
    { ministry_id: A.id, campaign_id: campA.id, title: "Vídeo A", type: "video" },
    { ministry_id: B.id, campaign_id: campB.id, title: "Vídeo B", type: "video" },
  ]).execute();
  await db.insertInto("app.investments").values([
    { ministry_id: A.id, campaign_id: campA.id, kind: "realized", description: "Mídia A", amount: 100 },
    { ministry_id: B.id, campaign_id: campB.id, kind: "realized", description: "Mídia B", amount: 900 },
  ]).execute();

  const account = await makeConnectedAccount(db, "meta");
  const asset = await makeAsset(db, account.id, "meta_ad_account");
  extA = await makeExternalCampaign(db, asset.id, A.id);
  extB = await makeExternalCampaign(db, asset.id, B.id);
  for (const day of ["2026-03-01", "2026-03-02"]) {
    await addObservation(db, { metric: "impressions", ministryId: A.id, entityId: extA.id, value: 1000, day });
    await addObservation(db, { metric: "impressions", ministryId: B.id, entityId: extB.id, value: 50_000, day });
    await addObservation(db, { metric: "spend", ministryId: A.id, entityId: extA.id, value: 10, day });
    await addObservation(db, { metric: "spend", ministryId: B.id, entityId: extB.id, value: 500, day });
  }
  await db.insertInto("app.reports").values([
    { ministry_id: A.id, scope_type: "ministry", period_start: "2026-01-01", period_end: "2026-03-31", title: "Relatório A", status: "published" },
    { ministry_id: B.id, scope_type: "ministry", period_start: "2026-01-01", period_end: "2026-03-31", title: "Relatório B", status: "published" },
    { ministry_id: A.id, scope_type: "ministry", period_start: "2026-01-01", period_end: "2026-03-31", title: "Rascunho A", status: "draft" },
  ]).execute();
});

afterAll(async () => {
  await db.destroy();
});

describe("1. Usuário do Ministério A não consulta dados do Ministério B", () => {
  it("lista apenas o próprio ministério e seus registros", async () => {
    await as(leaderA.id, async (trx) => {
      const ministries = await trx.selectFrom("app.ministries").select("id").execute();
      expect(ministries.map((m) => m.id)).toEqual([A.id]);
      const campaigns = await trx.selectFrom("app.campaigns").select("ministry_id").execute();
      expect(campaigns.every((c) => c.ministry_id === A.id)).toBe(true);
      const events = await trx.selectFrom("app.events").select("ministry_id").execute();
      expect(events.every((c) => c.ministry_id === A.id)).toBe(true);
      const tasks = await trx.selectFrom("app.tasks").select(["ministry_id", "name"]).execute();
      expect(tasks.map((t) => t.name)).toEqual(["Arte A"]);
      const deliverables = await trx.selectFrom("app.deliverables").select("title").execute();
      expect(deliverables.map((d) => d.title)).toEqual(["Vídeo A"]);
      const ext = await trx.selectFrom("app.external_campaigns").select("id").execute();
      expect(ext.map((e) => e.id)).toEqual([extA.id]);
    });
  });

  it("itens não classificados ficam visíveis apenas para a visão global", async () => {
    const forLeader = await as(leaderA.id, (trx) => trx.selectFrom("app.tasks").select("id").where("ministry_id", "is", null).execute());
    expect(forLeader).toHaveLength(0);
    const forAgency = await as(agencyMgrA.id, (trx) => trx.selectFrom("app.tasks").select("id").where("ministry_id", "is", null).execute());
    expect(forAgency).toHaveLength(0);
    const forGlobal = await as(agencyGlobal.id, (trx) => trx.selectFrom("app.tasks").select("id").where("ministry_id", "is", null).execute());
    expect(forGlobal).toHaveLength(1);
  });

  it("relatórios: só publicados do próprio ministério; rascunhos apenas para gestão", async () => {
    const leaderReports = await as(leaderA.id, (trx) => trx.selectFrom("app.reports").select("title").orderBy("title").execute());
    expect(leaderReports.map((r) => r.title)).toEqual(["Relatório A"]);
    const managerReports = await as(agencyMgrA.id, (trx) => trx.selectFrom("app.reports").select("title").orderBy("title").execute());
    expect(managerReports.map((r) => r.title)).toEqual(["Rascunho A", "Relatório A"]);
  });
});

describe("2. Manipular o ID não dá acesso a outro ministério", () => {
  it("consulta por ID de B retorna vazio", async () => {
    await as(leaderA.id, async (trx) => {
      expect(await trx.selectFrom("app.campaigns").select("id").where("id", "=", campB.id).executeTakeFirst()).toBeUndefined();
      expect(await trx.selectFrom("app.ministries").select("id").where("id", "=", B.id).executeTakeFirst()).toBeUndefined();
      expect(await trx.selectFrom("app.events").select("id").where("id", "=", eventB.id).executeTakeFirst()).toBeUndefined();
    });
  });

  it("alterações em registros de B não afetam nenhuma linha", async () => {
    const result = await as(agencyMgrA.id, (trx) =>
      trx.updateTable("app.campaigns").set({ name: "invadido" }).where("id", "=", campB.id).executeTakeFirst());
    expect(Number(result.numUpdatedRows)).toBe(0);
    const del = await as(agencyMgrA.id, (trx) => trx.deleteFrom("app.campaigns").where("id", "=", campB.id).executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0);
    const still = await db.selectFrom("app.campaigns").select("name").where("id", "=", campB.id).executeTakeFirstOrThrow();
    expect(still.name).toBe("Encontro de Mulheres");
  });

  it("não é possível criar registros em B nem vincular itens de A a campanhas de B", async () => {
    await expect(as(agencyMgrA.id, (trx) =>
      trx.insertInto("app.campaigns").values({ ministry_id: B.id, name: "Intrusa" }).execute())).rejects.toThrow(/row-level security/);
    await expect(as(agencyMgrA.id, (trx) =>
      trx.insertInto("app.deliverables").values({ ministry_id: A.id, campaign_id: campB.id, title: "Cruzado", type: "arte" }).execute()))
      .rejects.toThrow(/outro ministério/);
    await expect(as(agencyMgrA.id, (trx) =>
      trx.insertInto("app.campaign_events").values({ campaign_id: campA.id, event_id: eventB.id }).execute())).rejects.toThrow();
  });

  it("liderança não consegue escrever, mesmo no próprio ministério", async () => {
    await expect(as(leaderA.id, (trx) =>
      trx.insertInto("app.campaigns").values({ ministry_id: A.id, name: "Liderança" }).execute())).rejects.toThrow(/row-level security/);
  });

  it("responsável operacional aprova entregável, mas não edita conteúdo", async () => {
    const deliverable = await db.selectFrom("app.deliverables").select("id").where("ministry_id", "=", A.id).executeTakeFirstOrThrow();
    const ok = await as(opA.id, (trx) => trx.updateTable("app.deliverables").set({ status: "approved" }).where("id", "=", deliverable.id).executeTakeFirst());
    expect(Number(ok.numUpdatedRows)).toBe(1);
    await expect(as(opA.id, (trx) => trx.updateTable("app.deliverables").set({ title: "editado" }).where("id", "=", deliverable.id).execute()))
      .rejects.toThrow(/Sem permissão/);
  });
});

describe("5. Agregações (KPIs) não incluem áreas não autorizadas", () => {
  it("soma de impressões considera apenas A", async () => {
    const total = await as(leaderA.id, (trx) =>
      trx.selectFrom("app.metric_observations").select((eb) => eb.fn.sum<number>("value").as("total"))
        .where("metric_key", "=", "impressions").executeTakeFirstOrThrow());
    expect(Number(total.total)).toBe(2000);
    const global = await as(agencyGlobal.id, (trx) =>
      trx.selectFrom("app.metric_observations").select((eb) => eb.fn.sum<number>("value").as("total"))
        .where("metric_key", "=", "impressions").executeTakeFirstOrThrow());
    expect(Number(global.total)).toBe(102_000);
  });

  it("investimentos e métricas monetárias exigem permissão de investimento", async () => {
    const withPermission = await as(leaderA.id, (trx) => trx.selectFrom("app.investments").select("amount").execute());
    expect(withPermission.map((i) => i.amount)).toEqual([100]);
    const spendWith = await as(leaderA.id, (trx) => trx.selectFrom("app.metric_observations").select("value").where("metric_key", "=", "spend").execute());
    expect(spendWith).toHaveLength(2);

    const without = await as(leaderANoInvest.id, (trx) => trx.selectFrom("app.investments").select("amount").execute());
    expect(without).toHaveLength(0);
    const spendWithout = await as(leaderANoInvest.id, (trx) => trx.selectFrom("app.metric_observations").select("value").where("metric_key", "=", "spend").execute());
    expect(spendWithout).toHaveLength(0);
    // Métricas não monetárias continuam visíveis.
    const impressions = await as(leaderANoInvest.id, (trx) => trx.selectFrom("app.metric_observations").select("value").where("metric_key", "=", "impressions").execute());
    expect(impressions).toHaveLength(2);
  });
});

describe("6. Usuários removidos perdem o acesso", () => {
  it("remoção do vínculo revoga o acesso imediatamente", async () => {
    const temp = await makeUser(db, { role: "ministry" });
    await addMember(db, temp.id, A.id, "leader");
    const before = await as(temp.id, (trx) => trx.selectFrom("app.campaigns").select("id").execute());
    expect(before.length).toBeGreaterThan(0);
    await db.deleteFrom("app.ministry_memberships").where("user_id", "=", temp.id).execute();
    const after = await as(temp.id, (trx) => trx.selectFrom("app.campaigns").select("id").execute());
    expect(after).toHaveLength(0);
  });

  it("usuário desativado não acessa dados nem com sessão anterior", async () => {
    const temp = await makeUser(db, { role: "ministry" });
    await addMember(db, temp.id, A.id, "leader");
    const policy = { idleHours: 1, absoluteDays: 1 };
    const { token } = await createSession(db, temp.id, policy);
    expect(await validateSessionToken(db, token, policy)).not.toBeNull();
    await db.updateTable("app.users").set({ status: "disabled" }).where("id", "=", temp.id).execute();
    expect(await validateSessionToken(db, token, policy)).toBeNull();
    const rows = await as(temp.id, (trx) => trx.selectFrom("app.campaigns").select("id").execute());
    expect(rows).toHaveLength(0);
  });

  it("revogação de sessões invalida tokens emitidos", async () => {
    const temp = await makeUser(db, { role: "ministry" });
    const policy = { idleHours: 1, absoluteDays: 1 };
    const { token } = await createSession(db, temp.id, policy);
    expect(await revokeAllUserSessions(db, temp.id)).toBe(1);
    expect(await validateSessionToken(db, token, policy)).toBeNull();
  });
});

describe("7. Apenas administradores acessam configurações globais", () => {
  it("configurações, regras, convites e logs são restritos", async () => {
    for (const user of [leaderA, agencyMgrA, agencyGlobal]) {
      await expect(as(user.id, (trx) => trx.insertInto("app.app_settings").values({ key: "branding", value: JSON.stringify({ name: "x" }) }).execute()))
        .rejects.toThrow(/row-level security/);
      await expect(as(user.id, (trx) => trx.insertInto("app.mapping_rules").values({ provider: "asana", rule_type: "asana_project", ministry_id: A.id }).execute()))
        .rejects.toThrow(/row-level security/);
      await expect(as(user.id, (trx) => trx.insertInto("app.ministries").values({ name: "Novo", slug: "novo" }).execute()))
        .rejects.toThrow(/row-level security/);
      expect(await as(user.id, (trx) => trx.selectFrom("app.invitations").select("id").execute())).toHaveLength(0);
      expect(await as(user.id, (trx) => trx.selectFrom("app.sync_logs").select("id").execute())).toHaveLength(0);
      const promoted = await as(user.id, (trx) => trx.updateTable("app.users").set({ global_role: "superadmin" }).where("id", "=", user.id).executeTakeFirst());
      expect(Number(promoted.numUpdatedRows)).toBe(0);
    }
    await as(superadmin.id, (trx) => trx.insertInto("app.app_settings").values({ key: "branding", value: JSON.stringify({ name: "x" }) }).execute());
  });

  it("usuário de ministério não vê contas conectadas nem a fila de sincronização", async () => {
    expect(await as(leaderA.id, (trx) => trx.selectFrom("app.connected_accounts").select("id").execute())).toHaveLength(0);
    expect(await as(leaderA.id, (trx) => trx.selectFrom("app.sync_jobs").select("id").execute())).toHaveLength(0);
  });

  it("sessões e limites de taxa não são acessíveis pelo papel da aplicação", async () => {
    await expect(as(superadmin.id, (trx) => trx.selectFrom("app.sessions").select("id").execute())).rejects.toThrow(/permission denied/);
    await expect(as(superadmin.id, (trx) => trx.selectFrom("app.oauth_states").select("state_hash").execute())).rejects.toThrow(/permission denied/);
  });
});

describe("8. Credenciais nunca são legíveis pelo caminho de usuário", () => {
  it("credentials_encrypted e password_hash geram permission denied — inclusive para superadmin", async () => {
    await expect(as(superadmin.id, (trx) => trx.selectFrom("app.connected_accounts").select("credentials_encrypted").execute()))
      .rejects.toThrow(/permission denied/);
    await expect(as(superadmin.id, (trx) => trx.selectFrom("app.users").select("password_hash").execute()))
      .rejects.toThrow(/permission denied/);
    await expect(as(superadmin.id, (trx) => sql`select * from app.connected_accounts`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(as(superadmin.id, (trx) => trx.selectFrom("app.tasks").select("raw").execute())).rejects.toThrow(/permission denied/);
  });

  it("sem contexto de usuário, nenhuma linha é visível", async () => {
    const rows = await db.transaction().execute(async (trx) => {
      await sql`set local role atitude_app`.execute(trx);
      return trx.selectFrom("app.campaigns").select("id").execute();
    });
    expect(rows).toHaveLength(0);
  });
});

describe("Auditoria", () => {
  it("o papel da aplicação não altera nem forja registros de auditoria", async () => {
    await expect(as(superadmin.id, (trx) => trx.insertInto("app.activity_logs").values({ entity_type: "x", action: "y" }).execute()))
      .rejects.toThrow(/permission denied/);
    await as(leaderA.id, (trx) => sql`select app.log_activity(${A.id}::uuid, 'campaign', null, 'viewed', 'teste', '{}'::jsonb, 'ministry')`.execute(trx));
    const log = await db.selectFrom("app.activity_logs").select("actor_user_id").where("action", "=", "viewed").executeTakeFirstOrThrow();
    expect(log.actor_user_id).toBe(leaderA.id);
  });
});
