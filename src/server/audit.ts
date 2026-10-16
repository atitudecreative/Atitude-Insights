import type { Database, Tx } from "@/server/db";
import { sql } from "@/server/db";
import type { Json } from "@/server/db/schema.generated";

export interface AuditEntry {
  ministryId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  summary?: string;
  changes?: Record<string, unknown>;
  visibility?: "ministry" | "admin";
}

/** Registro de auditoria dentro de uma transação de usuário (ator = app.user_id). */
export async function audit(trx: Tx, entry: AuditEntry): Promise<void> {
  await sql`select app.log_activity(${entry.ministryId ?? null}::uuid, ${entry.entityType}, ${entry.entityId ?? null},
    ${entry.action}, ${entry.summary ?? null}, ${JSON.stringify(entry.changes ?? {})}::jsonb, ${entry.visibility ?? "ministry"})`.execute(trx);
}

/** Registro de auditoria em contexto de sistema (login, convites, sincronização). */
export async function auditSystem(db: Database | Tx, actorUserId: string | null, entry: AuditEntry & { ip?: string | null }): Promise<void> {
  await db
    .insertInto("app.activity_logs")
    .values({
      actor_user_id: actorUserId,
      ministry_id: entry.ministryId ?? null,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      action: entry.action,
      summary: entry.summary ?? null,
      changes: JSON.stringify(entry.changes ?? {}) as unknown as Json,
      visibility: entry.visibility ?? "admin",
      ip: entry.ip ?? null,
    })
    .execute();
}
