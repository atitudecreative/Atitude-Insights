/**
 * Critérios 3, 4 e 5 no nível de serviço: dashboards, relatórios e PDF usam
 * o mesmo caminho RLS e nunca incluem dados de ministérios não autorizados.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, resetData, testDbUrl } from "../support/db";
import { addMember, addObservation, makeAsset, makeCampaign, makeConnectedAccount, makeExternalCampaign, makeMinistry, makeUser } from "../support/fixtures";

process.env.DATABASE_URL = testDbUrl();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const db = createTestDb();
type Actor = import("@/server/auth/types").Actor;
const actorOf = (u: { id: string; email: string }, role: Actor["globalRole"] = "ministry"): Actor => ({
  userId: u.id, sessionId: "test", email: u.email, name: "Teste", globalRole: role, agencyGlobalAccess: role === "agency" ? "read" : "none",
});

let A: { id: string }, B: { id: string };
let leader: Actor, leaderNoInvest: Actor, manager: Actor, global: Actor;
let campA: { id: string }, campB: { id: string };

beforeAll(async () => {
  await resetData(db);
  A = await makeMinistry(db, "Kids");
  B = await makeMinistry(db, "Global");
  const uLeader = await makeUser(db);
  const uNo = await makeUser(db);
  const uMgr = await makeUser(db, { role: "agency" });
  const uGlobal = await makeUser(db, { role: "agency", access: "read" });
  await addMember(db, uLeader.id, A.id, "leader", true);
  await addMember(db, uNo.id, A.id, "leader", false);
  await addMember(db, uMgr.id, A.id, "agency_manager");
  leader = actorOf(uLeader);
  leaderNoInvest = actorOf(uNo);
  manager = { ...actorOf(uMgr, "agency"), agencyGlobalAccess: "none" };
  global = actorOf(uGlobal, "agency");

  campA = await makeCampaign(db, A.id, "Conferência Kids");
  campB = await makeCampaign(db, B.id, "Campanha Global Secreta");
  const now = new Date();
  await db.insertInto("app.tasks").values([
    { source: "manual", name: "Arte A concluída", ministry_id: A.id, campaign_id: campA.id, completed: true, completed_at: now, classification: "manual" },
    { source: "manual", name: "Arte B concluída", ministry_id: B.id, campaign_id: campB.id, completed: true, completed_at: now, classification: "manual" },
  ]).execute();
  await db.insertInto("app.investments").values([
    { ministry_id: A.id, campaign_id: campA.id, kind: "realized", description: "Impulsionamento A", amount: 150, spent_on: now.toISOString().slice(0, 10) },
    { ministry_id: B.id, campaign_id: campB.id, kind: "realized", description: "Impulsionamento B", amount: 9999, spent_on: now.toISOString().slice(0, 10) },
  ]).execute();
  const acc = await makeConnectedAccount(db, "meta");
  const asset = await makeAsset(db, acc.id, "meta_ad_account");
  await db.insertInto("app.asset_ministry_mappings").values([{ external_asset_id: asset.id, ministry_id: A.id }, { external_asset_id: asset.id, ministry_id: B.id }]).execute();
  const extA = await makeExternalCampaign(db, asset.id, A.id);
  const extB = await makeExternalCampaign(db, asset.id, B.id);
  await db.insertInto("app.campaign_external_campaigns").values([{ campaign_id: campA.id, external_campaign_id: extA.id }, { campaign_id: campB.id, external_campaign_id: extB.id }]).execute();
  const today = now.toISOString().slice(0, 10);
  for (const [m, e, imp, spend] of [[A.id, extA.id, 1000, 20], [B.id, extB.id, 777_000, 5000]] as const) {
    await addObservation(db, { metric: "impressions", ministryId: m, entityId: e, value: imp, day: today });
    await addObservation(db, { metric: "clicks", ministryId: m, entityId: e, value: imp / 100, day: today });
    await addObservation(db, { metric: "spend", ministryId: m, entityId: e, value: spend, day: today });
  }
});

afterAll(async () => {
  await (await import("@/server/db")).closeSystemDb();
  await db.destroy();
});

const period = () => {
  const end = new Date().toISOString().slice(0, 10);
  return { start: "2000-01-01", end };
};

describe("Dashboards (KPIs e gráficos) respeitam o escopo", () => {
  it("liderança de A não agrega dados de B, mesmo filtrando pelo ID de B", async () => {
    const { getDashboard } = await import("@/server/services/analytics");
    const d = await getDashboard(leader, { mode: "production", ...period() });
    expect(d.scope.ministryIds).toEqual([A.id]);
    expect(d.communication.paid.impressions.value).toBe(1000);
    expect(d.communication.paid.spend.value).toBe(20);
    expect(d.operational.tasksCompleted).toBe(1);
    expect(d.alerts).toBeNull();

    const forced = await getDashboard(leader, { mode: "production", ...period(), ministryId: B.id });
    expect(forced.scope.ministryIds).toEqual([]);
    expect(forced.communication.paid.impressions.value ?? 0).toBe(0);
    expect(forced.operational.tasksCompleted).toBe(0);

    const viaCampaign = await getDashboard(leader, { mode: "production", ...period(), campaignId: campB.id });
    expect(viaCampaign.communication.paid.impressions.value ?? null).toBeNull();
  });

  it("visão global soma todos os ministérios", async () => {
    const { getDashboard } = await import("@/server/services/analytics");
    const d = await getDashboard(global, { mode: "production", ...period() });
    expect(d.communication.paid.impressions.value).toBe(778_000);
    expect(d.operational.tasksCompleted).toBe(2);
  });

  it("indicadores derivados são calculados a partir das somas", async () => {
    const { getDashboard } = await import("@/server/services/analytics");
    const d = await getDashboard(leader, { mode: "production", ...period() });
    expect(d.communication.paid.ctr.value).toBeCloseTo(1); // 10 / 1000 × 100
    expect(d.communication.paid.cpm.value).toBeCloseTo(20); // 20 / 1000 × 1000
    expect(d.communication.paid.cpc.value).toBeCloseTo(2); // 20 / 10
  });

  it("sem permissão de investimento: valores monetários ficam restritos", async () => {
    const { getDashboard } = await import("@/server/services/analytics");
    const d = await getDashboard(leaderNoInvest, { mode: "production", ...period() });
    expect(d.communication.paid.spend.state).toBe("restricted");
    expect(d.communication.paid.cpc.state).toBe("restricted");
    expect(d.communication.paid.impressions.value).toBe(1000);
    expect(d.byCampaign).toBeNull();
  });

  it("modo demonstração não mistura dados reais", async () => {
    const { getDashboard } = await import("@/server/services/analytics");
    const d = await getDashboard(global, { mode: "demo", ...period() });
    expect(d.scope.ministryIds).toEqual([]);
    expect(d.operational.tasksCompleted).toBe(0);
  });
});

describe("Relatórios e exportações", () => {
  it("relatório de A não contém nada de B; tentativa com escopo de B é negada", async () => {
    const { liveReport } = await import("@/server/services/reports");
    const r = await liveReport(leader, { scopeType: "ministry", ministryId: A.id, ...period() });
    const json = JSON.stringify(r);
    expect(json).toContain("Arte A concluída");
    expect(json).not.toContain("Arte B");
    expect(json).not.toContain("Secreta");
    expect(json).not.toContain("9999");
    expect(r.financials?.realizedManual).toBe(150);
    await expect(liveReport(leader, { scopeType: "ministry", ministryId: B.id, ...period() })).rejects.toThrow();
    await expect(liveReport(leader, { scopeType: "campaign", campaignId: campB.id, ...period() })).rejects.toThrow();
    await expect(liveReport(leader, { scopeType: "agency", ...period() })).rejects.toThrow();
  });

  it("sem permissão de investimento, o relatório não traz seção financeira", async () => {
    const { liveReport } = await import("@/server/services/reports");
    const r = await liveReport(leaderNoInvest, { scopeType: "ministry", ministryId: A.id, ...period() });
    expect(r.financials).toBeNull();
    expect(JSON.stringify(r.data)).not.toMatch(/150|Impulsionamento/);
  });

  it("versão publicada: financeiro protegido por RLS para quem não tem permissão", async () => {
    const { createReport, publishReport, getReport, getReportVersion } = await import("@/server/services/reports");
    const id = await createReport(manager, { title: "Prestação de contas A", scopeType: "ministry", ministryId: A.id, ...period() });
    // Rascunho invisível para a liderança.
    expect(await getReport(leader, id)).toBeNull();
    expect(await publishReport(manager, id)).toBe(1);
    const forLeader = await getReportVersion(leader, id);
    expect(forLeader?.financials?.realizedManual).toBe(150);
    const forNoInvest = await getReportVersion(leaderNoInvest, id);
    expect(forNoInvest?.data.subject.ministryName).toBe("Kids");
    expect(forNoInvest?.financials).toBeNull();
    // Usuário sem vínculo não acessa.
    const outsider = actorOf(await makeUser(db));
    expect(await getReport(outsider, id)).toBeNull();
    expect(await getReportVersion(outsider, id)).toBeNull();
  });

  it("liderança não cria nem publica relatórios", async () => {
    const { createReport } = await import("@/server/services/reports");
    await expect(createReport(leader, { title: "Tentativa", scopeType: "ministry", ministryId: A.id, ...period() })).rejects.toThrow();
  });

  it("gera um PDF válido com os dados do escopo", async () => {
    const { liveReport } = await import("@/server/services/reports");
    const { renderReportPdf } = await import("@/server/reports/pdf");
    const r = await liveReport(leader, { scopeType: "ministry", ministryId: A.id, ...period() });
    const pdf = await renderReportPdf({ ...r, text: { title: "Relatório Kids" }, brand: { name: "Atitude Insights", organization: "Agência", primaryColor: "#4f46e5" }, investmentRestricted: false });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(2000);
  }, 30_000);
});
