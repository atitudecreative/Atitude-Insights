import { sql, type Database } from "@/server/db";

/**
 * Limite de requisições persistido no PostgreSQL (funciona com várias
 * instâncias/serverless). Retorna `true` se a operação é permitida.
 */
export async function consumeRateLimit(db: Database, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const result = await sql<{ count: number }>`
    insert into app.rate_limits as r (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when r.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else r.count + 1 end,
      window_start = case when r.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else r.window_start end
    returning count`.execute(db);
  return (result.rows[0]?.count ?? 0) <= limit;
}

export async function resetRateLimit(db: Database, key: string): Promise<void> {
  await db.deleteFrom("app.rate_limits").where("key", "=", key).execute();
}
