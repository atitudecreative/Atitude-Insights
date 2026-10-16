import { randomToken, sha256 } from "@/server/security/crypto";
import type { Database } from "@/server/db";
import type { Actor, AgencyGlobalAccess, GlobalRole } from "./types";

export const SESSION_COOKIE = "ai_session";

export interface SessionPolicy {
  idleHours: number;
  absoluteDays: number;
}

export async function createSession(
  db: Database,
  userId: string,
  policy: SessionPolicy,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = new Date(now + policy.idleHours * 3600_000);
  const absolute = new Date(now + policy.absoluteDays * 86400_000);
  await db
    .insertInto("app.sessions")
    .values({
      user_id: userId,
      token_hash: sha256(token),
      expires_at: expiresAt < absolute ? expiresAt : absolute,
      absolute_expires_at: absolute,
      ip: meta.ip?.slice(0, 64) ?? null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  await db.updateTable("app.users").set({ last_login_at: new Date() }).where("id", "=", userId).execute();
  return { token, expiresAt: expiresAt < absolute ? expiresAt : absolute };
}

/**
 * Valida o token da sessão: sessão não revogada, não expirada e usuário
 * ativo. Renova a expiração por inatividade (sliding) até o limite absoluto.
 */
export async function validateSessionToken(db: Database, token: string | undefined, policy: SessionPolicy): Promise<Actor | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await db
    .selectFrom("app.sessions as s")
    .innerJoin("app.users as u", "u.id", "s.user_id")
    .select([
      "s.id as session_id", "s.expires_at", "s.absolute_expires_at", "s.last_seen_at",
      "u.id as user_id", "u.email", "u.name", "u.global_role", "u.agency_global_access",
    ])
    .where("s.token_hash", "=", sha256(token))
    .where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", new Date())
    .where("u.status", "=", "active")
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;

  // Atualiza no máximo a cada 5 minutos para reduzir escrita.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    const nextExpiry = new Date(Math.min(Date.now() + policy.idleHours * 3600_000, new Date(row.absolute_expires_at).getTime()));
    await db
      .updateTable("app.sessions")
      .set({ last_seen_at: new Date(), expires_at: nextExpiry })
      .where("id", "=", row.session_id)
      .execute();
  }

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    email: row.email,
    name: row.name,
    globalRole: row.global_role as GlobalRole,
    agencyGlobalAccess: row.agency_global_access as AgencyGlobalAccess,
  };
}

export async function revokeSessionByToken(db: Database, token: string): Promise<void> {
  await db.updateTable("app.sessions").set({ revoked_at: new Date() }).where("token_hash", "=", sha256(token)).execute();
}

export async function revokeAllUserSessions(db: Database, userId: string): Promise<number> {
  const result = await db
    .updateTable("app.sessions")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
