import { z } from "zod";
import type { Database } from "@/server/db";
import { auditSystem } from "@/server/audit";
import { randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit, resetRateLimit } from "@/server/security/rate-limit";
import { hashPassword, passwordPolicyError, verifyPassword } from "./password";
import { createSession, revokeAllUserSessions, type SessionPolicy } from "./sessions";
import type { AgencyGlobalAccess, GlobalRole, MinistryRole } from "./types";

export class AuthError extends Error {
  constructor(message: string, public readonly code: "invalid" | "rate_limited" | "expired" | "policy") {
    super(message);
  }
}

const GENERIC_LOGIN_ERROR = "E-mail ou senha inválidos.";

export async function login(
  db: Database,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
  policy: SessionPolicy,
): Promise<{ token: string; expiresAt: Date; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const ip = input.ip ?? "unknown";
  const allowedPair = await consumeRateLimit(db, `login:${ip}:${email}`, 5, 15 * 60);
  const allowedIp = await consumeRateLimit(db, `login-ip:${ip}`, 30, 15 * 60);
  if (!allowedPair || !allowedIp) {
    await auditSystem(db, null, { entityType: "auth", action: "login_rate_limited", summary: email, ip });
    throw new AuthError("Muitas tentativas. Aguarde alguns minutos e tente novamente.", "rate_limited");
  }

  const user = await db
    .selectFrom("app.users")
    .select(["id", "password_hash", "status"])
    .where("email", "=", email)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const ok = await verifyPassword(input.password, user?.password_hash);
  if (!user || !ok || user.status !== "active") {
    await auditSystem(db, user?.id ?? null, { entityType: "auth", action: "login_failed", summary: email, ip });
    throw new AuthError(GENERIC_LOGIN_ERROR, "invalid");
  }
  await resetRateLimit(db, `login:${ip}:${email}`);
  const session = await createSession(db, user.id, policy, { ip: input.ip, userAgent: input.userAgent });
  await auditSystem(db, user.id, { entityType: "auth", entityId: user.id, action: "login", ip });
  return { ...session, userId: user.id };
}

export const invitationInput = z
  .object({
    email: z.email().transform((v) => v.trim().toLowerCase()),
    name: z.string().trim().min(2).max(120),
    globalRole: z.enum(["superadmin", "agency", "ministry"]),
    agencyGlobalAccess: z.enum(["none", "read", "manage"]).default("none"),
    ministryId: z.uuid().nullable().optional(),
    ministryRole: z.enum(["agency_manager", "agency_viewer", "leader", "operational"]).nullable().optional(),
    canViewInvestment: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.globalRole !== "agency" && v.agencyGlobalAccess !== "none") {
      ctx.addIssue({ code: "custom", message: "Visão global só se aplica à equipe da agência", path: ["agencyGlobalAccess"] });
    }
    if (v.globalRole === "ministry" && (!v.ministryId || !v.ministryRole)) {
      ctx.addIssue({ code: "custom", message: "Usuários de ministério precisam de um ministério e papel", path: ["ministryId"] });
    }
    if (v.ministryRole && v.globalRole === "ministry" && !["leader", "operational"].includes(v.ministryRole)) {
      ctx.addIssue({ code: "custom", message: "Papel incompatível", path: ["ministryRole"] });
    }
    if (v.ministryRole && v.globalRole === "agency" && !["agency_manager", "agency_viewer"].includes(v.ministryRole)) {
      ctx.addIssue({ code: "custom", message: "Papel incompatível", path: ["ministryRole"] });
    }
    if (v.globalRole === "superadmin" && v.ministryId) {
      ctx.addIssue({ code: "custom", message: "Superadministradores não recebem vínculo", path: ["ministryId"] });
    }
  });
export type InvitationInput = z.input<typeof invitationInput>;

const INVITE_TTL_HOURS = 72;

/**
 * Cria convite com token de uso único (armazenado apenas como hash).
 * A autorização (superadmin) deve ser validada pelo chamador.
 */
export async function createInvitation(db: Database, invitedBy: string, raw: InvitationInput): Promise<{ token: string; id: string }> {
  const input = invitationInput.parse(raw);
  const existing = await db
    .selectFrom("app.users")
    .select("id")
    .where("email", "=", input.email)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (existing) throw new AuthError("Já existe um usuário com este e-mail.", "policy");

  const token = randomToken(32);
  // Revoga convites pendentes anteriores para o mesmo e-mail.
  await db
    .updateTable("app.invitations")
    .set({ revoked_at: new Date() })
    .where("email", "=", input.email)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .execute();
  const row = await db
    .insertInto("app.invitations")
    .values({
      email: input.email,
      name: input.name,
      token_hash: sha256(token),
      global_role: input.globalRole,
      agency_global_access: input.globalRole === "agency" ? input.agencyGlobalAccess : "none",
      ministry_id: input.globalRole === "superadmin" ? null : (input.ministryId ?? null),
      ministry_role: input.globalRole === "superadmin" ? null : (input.ministryRole ?? null),
      can_view_investment: input.canViewInvestment,
      invited_by: invitedBy,
      kind: "invite",
      expires_at: new Date(Date.now() + INVITE_TTL_HOURS * 3600_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await auditSystem(db, invitedBy, {
    entityType: "invitation", entityId: row.id, action: "invite_created",
    summary: `Convite para ${input.email}`, ministryId: input.ministryId ?? null,
  });
  return { token, id: row.id };
}

export async function createPasswordReset(db: Database, requestedBy: string, userId: string): Promise<{ token: string }> {
  const user = await db.selectFrom("app.users").select(["id", "email", "name", "global_role"]).where("id", "=", userId)
    .where("deleted_at", "is", null).executeTakeFirst();
  if (!user) throw new AuthError("Usuário não encontrado.", "invalid");
  const token = randomToken(32);
  await db.updateTable("app.invitations").set({ revoked_at: new Date() })
    .where("user_id", "=", userId).where("kind", "=", "password_reset").where("accepted_at", "is", null).execute();
  await db.insertInto("app.invitations").values({
    email: user.email, name: user.name, token_hash: sha256(token), global_role: user.global_role,
    user_id: user.id, kind: "password_reset", invited_by: requestedBy,
    expires_at: new Date(Date.now() + 24 * 3600_000),
  }).execute();
  await auditSystem(db, requestedBy, { entityType: "user", entityId: userId, action: "password_reset_link_created" });
  return { token };
}

export async function getInvitationByToken(db: Database, token: string) {
  if (!token || token.length > 200) return null;
  return db
    .selectFrom("app.invitations as i")
    .leftJoin("app.ministries as m", "m.id", "i.ministry_id")
    .select(["i.id", "i.email", "i.name", "i.kind", "i.global_role", "i.expires_at", "i.accepted_at", "i.revoked_at", "m.name as ministry_name"])
    .where("i.token_hash", "=", sha256(token))
    .executeTakeFirst();
}

/**
 * Aceita convite (cria usuário + vínculo) ou redefine senha. Uso único:
 * o token é marcado como aceito na mesma transação, com bloqueio de linha.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  password: string,
  policy: SessionPolicy,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date; userId: string }> {
  const policyError = passwordPolicyError(password);
  if (policyError) throw new AuthError(policyError, "policy");
  const passwordHash = await hashPassword(password);

  const userId = await db.transaction().execute(async (trx) => {
    const inv = await trx
      .selectFrom("app.invitations")
      .selectAll()
      .where("token_hash", "=", sha256(token))
      .forUpdate()
      .executeTakeFirst();
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw new AuthError("Link inválido ou expirado. Solicite um novo convite.", "expired");
    }
    let id: string;
    if (inv.kind === "password_reset") {
      if (!inv.user_id) throw new AuthError("Link inválido.", "invalid");
      await trx.updateTable("app.users")
        .set({ password_hash: passwordHash, password_changed_at: new Date(), status: "active" })
        .where("id", "=", inv.user_id).where("status", "<>", "disabled").execute();
      id = inv.user_id;
      // Troca de senha encerra sessões existentes.
      await revokeAllUserSessions(trx as unknown as Database, id);
    } else {
      const created = await trx
        .insertInto("app.users")
        .values({
          email: inv.email, name: inv.name, password_hash: passwordHash, password_changed_at: new Date(),
          global_role: inv.global_role, agency_global_access: inv.agency_global_access, status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      id = created.id;
      if (inv.ministry_id && inv.ministry_role) {
        await trx.insertInto("app.ministry_memberships").values({
          user_id: id, ministry_id: inv.ministry_id, role: inv.ministry_role,
          can_view_investment: inv.can_view_investment, created_by: inv.invited_by,
        }).execute();
      }
    }
    await trx.updateTable("app.invitations").set({ accepted_at: new Date(), user_id: id }).where("id", "=", inv.id).execute();
    await auditSystem(trx, id, {
      entityType: "invitation", entityId: inv.id,
      action: inv.kind === "password_reset" ? "password_reset" : "invite_accepted", ip: meta.ip ?? null,
    });
    return id;
  });

  const session = await createSession(db, userId, policy, meta);
  return { ...session, userId };
}

/** Cria (ou promove) o primeiro superadministrador — usado pelo script de bootstrap. */
export async function bootstrapSuperadmin(db: Database, email: string, name: string, password: string): Promise<string> {
  const policyError = passwordPolicyError(password);
  if (policyError) throw new AuthError(policyError, "policy");
  const passwordHash = await hashPassword(password);
  const normalized = email.trim().toLowerCase();
  const existing = await db.selectFrom("app.users").select("id").where("email", "=", normalized).where("deleted_at", "is", null).executeTakeFirst();
  if (existing) {
    await db.updateTable("app.users").set({ global_role: "superadmin", agency_global_access: "none", status: "active", password_hash: passwordHash })
      .where("id", "=", existing.id).execute();
    return existing.id;
  }
  const row = await db.insertInto("app.users").values({
    email: normalized, name, password_hash: passwordHash, global_role: "superadmin", status: "active", password_changed_at: new Date(),
  }).returning("id").executeTakeFirstOrThrow();
  return row.id;
}

export type { GlobalRole, MinistryRole, AgencyGlobalAccess };
