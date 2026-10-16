import { sql, type Database } from "@/server/db";

/** Retenção de dados (docs/lgpd.md). Executa no máximo uma vez por dia. */
export async function runMaintenance(db: Database, now = new Date()): Promise<boolean> {
  const row = await db.selectFrom("app.app_settings").select("value").where("key", "=", "maintenance_last_run").executeTakeFirst();
  const last = typeof row?.value === "string" ? Date.parse(row.value) : 0;
  if (now.getTime() - last < 24 * 3600_000) return false;
  await sql`delete from app.sync_logs where created_at < now() - interval '180 days'`.execute(db);
  await sql`delete from app.sessions where coalesce(revoked_at, expires_at) < now() - interval '30 days'`.execute(db);
  await sql`delete from app.invitations where accepted_at is null and expires_at < now() - interval '90 days'`.execute(db);
  await sql`delete from app.oauth_states where expires_at < now() - interval '1 day'`.execute(db);
  await sql`delete from app.rate_limits where window_start < now() - interval '1 day'`.execute(db);
  await sql`delete from app.activity_logs where created_at < now() - interval '2 years'`.execute(db);
  const value = JSON.stringify(now.toISOString());
  await sql`insert into app.app_settings (key, value) values ('maintenance_last_run', ${value}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`.execute(db);
  return true;
}
