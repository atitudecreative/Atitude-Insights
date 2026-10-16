import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "../../src/server/db/schema.generated";

pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export function testDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url) return url;
  const admin = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://atitude:atitude@localhost:5432/postgres");
  admin.pathname = `/${process.env.TEST_DATABASE_NAME ?? "atitude_test"}`;
  return admin.toString();
}

export function createTestDb(): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDbUrl(), max: 5 }) }) });
}

/** Limpa todos os dados (mantém tabelas de referência semeadas pelas migrações). */
export async function resetData(db: Kysely<DB>) {
  await sql`truncate app.users, app.ministries, app.connected_accounts, app.activity_logs, app.app_settings,
    app.rate_limits restart identity cascade`.execute(db);
}
