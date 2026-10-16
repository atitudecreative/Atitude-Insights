import pg from "pg";
import { runMigrations } from "../../src/server/db/migrator";

/**
 * Recria o banco de testes do zero e aplica todas as migrações. Requer um
 * PostgreSQL acessível em TEST_DATABASE_ADMIN_URL (padrão: localhost).
 */
export default async function setup() {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://atitude:atitude@localhost:5432/postgres";
  const dbName = process.env.TEST_DATABASE_NAME ?? "atitude_test";
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  process.env.TEST_DATABASE_URL = url.toString();
  await runMigrations(url.toString(), undefined, () => {});
}
