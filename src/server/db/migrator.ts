import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/**
 * Executor de migrações SQL versionadas (db/migrations/NNNN_nome.sql).
 * Cada arquivo roda em uma transação; o checksum impede edição silenciosa
 * de migrações já aplicadas.
 */
export async function runMigrations(connectionString: string, dir = path.resolve("db/migrations"), log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists public.schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>("select version, checksum from public.schema_migrations")).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = applied.get(file);
      if (existing) {
        if (existing !== checksum) throw new Error(`Migração ${file} foi alterada após ser aplicada (checksum divergente).`);
        continue;
      }
      log(`→ aplicando ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into public.schema_migrations (version, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Falha na migração ${file}: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
