import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { hashPassword } from "../../src/server/auth/password";
import { runMigrations } from "../../src/server/db/migrator";
import type { DB } from "../../src/server/db/schema.generated";

export const E2E_PASSWORD = "SenhaE2E12345";
export const E2E = {
  admin: "admin@e2e.test",
  leaderA: "lider.kids@e2e.test",
  leaderB: "lider.mulheres@e2e.test",
  agency: "agencia@e2e.test",
  removed: "removido@e2e.test",
};

/** Banco E2E recriado do zero com dois ministérios isolados. */
export async function seedE2E(adminUrl: string, dbName: string) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  await runMigrations(url.toString(), undefined, () => {});
  pg.types.setTypeParser(1082, (v) => v);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString() }) }) });
  const password_hash = await hashPassword(E2E_PASSWORD);
  const mk = (email: string, name: string, global_role: "superadmin" | "agency" | "ministry", agency_global_access: "none" | "read" | "manage" = "none") =>
    db.insertInto("app.users").values({ email, name, password_hash, global_role, agency_global_access, status: "active" }).returning("id").executeTakeFirstOrThrow();
  await mk(E2E.admin, "Admin E2E", "superadmin");
  const leaderA = await mk(E2E.leaderA, "Líder Kids", "ministry");
  const leaderB = await mk(E2E.leaderB, "Líder Mulheres", "ministry");
  const agency = await mk(E2E.agency, "Agência E2E", "agency", "none");
  const removed = await mk(E2E.removed, "Usuário Removido", "ministry");
  const A = await db.insertInto("app.ministries").values({ name: "Atitude Kids", slug: "atitude-kids", description: "Ministério infantil" }).returning("id").executeTakeFirstOrThrow();
  const B = await db.insertInto("app.ministries").values({ name: "Mulheres", slug: "mulheres" }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("app.ministry_memberships").values([
    { user_id: leaderA.id, ministry_id: A.id, role: "leader", can_view_investment: true },
    { user_id: leaderB.id, ministry_id: B.id, role: "leader", can_view_investment: true },
    { user_id: agency.id, ministry_id: A.id, role: "agency_manager" },
    { user_id: removed.id, ministry_id: A.id, role: "leader" },
  ]).execute();
  const campA = await db.insertInto("app.campaigns").values({ ministry_id: A.id, name: "Conferência Kids 2026", status: "active", start_date: "2026-01-01", end_date: "2026-12-31" }).returning("id").executeTakeFirstOrThrow();
  const campB = await db.insertInto("app.campaigns").values({ ministry_id: B.id, name: "Encontro Secreto de Mulheres", status: "active", start_date: "2026-01-01", end_date: "2026-12-31" }).returning("id").executeTakeFirstOrThrow();
  const evB = await db.insertInto("app.events").values({ ministry_id: B.id, name: "Retiro Mulheres", starts_at: new Date("2026-11-20T19:00:00-03:00") }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("app.tasks").values([
    { source: "manual", ministry_id: A.id, campaign_id: campA.id, name: "Arte do convite Kids", classification: "manual", completed: true, completed_at: new Date() },
    { source: "manual", ministry_id: B.id, campaign_id: campB.id, name: "Vídeo secreto Mulheres", classification: "manual", completed: true, completed_at: new Date() },
  ]).execute();
  const delB = await db.insertInto("app.deliverables").values({ ministry_id: B.id, campaign_id: campB.id, title: "Peça confidencial B", type: "arte" }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("app.investments").values({ ministry_id: B.id, campaign_id: campB.id, kind: "realized", description: "Mídia B", amount: 4321 }).execute();
  const account = await db.insertInto("app.connected_accounts").values({
    provider: "meta", label: "Meta E2E", auth_type: "personal_token", status: "connected", sync_enabled: false,
    credentials_encrypted: "v1.TOKEN-SUPER-SECRETO-E2E.x.y",
  }).returning("id").executeTakeFirstOrThrow();
  const report = await db.insertInto("app.reports").values({ ministry_id: B.id, scope_type: "ministry", period_start: "2026-01-01", period_end: "2026-12-31", title: "Relatório Mulheres", status: "published" })
    .returning("id").executeTakeFirstOrThrow();
  await db.insertInto("app.report_versions").values({ report_id: report.id, ministry_id: B.id, version: 1, snapshot: JSON.stringify({}) as never }).execute();
  await db.destroy();
  return { url: url.toString(), ids: { A: A.id, B: B.id, campA: campA.id, campB: campB.id, evB: evB.id, delB: delB.id, account: account.id, reportB: report.id, removedUser: removed.id } };
}
