import "server-only";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { env } from "@/server/env";
import type { DB } from "./schema.generated";

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;

// `date` como string (YYYY-MM-DD) e `numeric` como número.
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value));

const globalForDb = globalThis as unknown as { __atitudeDb?: Database };

function createDb(): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: env().DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 }),
    }),
  });
}

/**
 * Conexão de SISTEMA (dono das tabelas, ignora RLS). Uso restrito a:
 * autenticação, sincronização de integrações e tarefas administrativas que já
 * validaram a autorização no servidor. Nunca use para leituras de usuário.
 */
export function systemDb(): Database {
  if (!globalForDb.__atitudeDb) globalForDb.__atitudeDb = createDb();
  return globalForDb.__atitudeDb;
}

/** Encerra o pool de sistema (scripts e testes). */
export async function closeSystemDb(): Promise<void> {
  const db = globalForDb.__atitudeDb;
  globalForDb.__atitudeDb = undefined;
  await db?.destroy();
}

/**
 * Executa `fn` em uma transação com o papel restrito `atitude_app` e o
 * usuário autenticado definido em `app.user_id`. Todas as políticas RLS se
 * aplicam: este é o ÚNICO caminho para consultas originadas por usuários.
 */
export async function withUserDb<T>(userId: string, fn: (trx: Tx) => Promise<T>, db: Database = systemDb()): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Identificador de usuário inválido");
  return db.transaction().execute(async (trx) => {
    await sql`set local role atitude_app`.execute(trx);
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
    return fn(trx);
  });
}

export { sql };
