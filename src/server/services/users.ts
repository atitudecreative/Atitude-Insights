import { z } from "zod";
import { systemDb } from "@/server/db";
import { env } from "@/server/env";
import { audit, auditSystem } from "@/server/audit";
import { AuthError, createInvitation, createPasswordReset, invitationInput } from "@/server/auth/service";
import { revokeAllUserSessions } from "@/server/auth/sessions";
import type { Actor, AgencyGlobalAccess, GlobalRole, MinistryRole } from "@/server/auth/types";
import { asUser, isUuid, ServiceError, zodErrors } from "./context";

/**
 * Gestão de usuários, vínculos e convites (somente superadministradores).
 *
 * Leituras e escritas permitidas pelas políticas RLS (users_update,
 * memberships_*) passam por `asUser`. A conexão de sistema (`systemDb`) é
 * usada apenas onde o papel da aplicação não tem GRANT — sessões e escrita
 * de convites — e SEMPRE depois de `assertSuperadmin` no servidor.
 */

export function assertSuperadmin(actor: Actor): void {
  if (actor.globalRole !== "superadmin") {
    throw new ServiceError("Apenas superadministradores podem gerenciar usuários.", "forbidden");
  }
}

const MINISTRY_ROLES_FOR: Record<GlobalRole, MinistryRole[]> = {
  superadmin: [],
  agency: ["agency_manager", "agency_viewer"],
  ministry: ["leader", "operational"],
};

/** Papéis de vínculo compatíveis com o papel global (espelha app.check_membership_role). */
export function compatibleMinistryRoles(globalRole: GlobalRole): MinistryRole[] {
  return MINISTRY_ROLES_FOR[globalRole];
}

export interface UserMembership {
  id: string;
  ministry_id: string;
  ministry_name: string;
  ministry_slug: string;
  role: MinistryRole;
  can_view_investment: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  global_role: GlobalRole;
  agency_global_access: AgencyGlobalAccess;
  status: "invited" | "active" | "disabled";
  last_login_at: Date | null;
  created_at: Date;
  memberships: UserMembership[];
}

const PAGE_SIZE = 25;

export async function listUsers(
  actor: Actor,
  opts: { q?: string; role?: string; status?: string; page?: number } = {},
): Promise<{ rows: UserRow[]; total: number; page: number; pageSize: number }> {
  assertSuperadmin(actor);
  const page = opts.page ?? 1;
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.users as u").where("u.deleted_at", "is", null);
    if (opts.q) {
      const like = `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or([eb("u.name", "ilike", like), eb("u.email", "ilike", like)]));
    }
    if (opts.role === "superadmin" || opts.role === "agency" || opts.role === "ministry") q = q.where("u.global_role", "=", opts.role);
    if (opts.status === "active" || opts.status === "disabled" || opts.status === "invited") q = q.where("u.status", "=", opts.status);
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const users = await q
      .select(["u.id", "u.email", "u.name", "u.global_role", "u.agency_global_access", "u.status", "u.last_login_at", "u.created_at"])
      .orderBy("u.name").limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE).execute();
    const memberships = users.length
      ? await trx.selectFrom("app.ministry_memberships as mm").innerJoin("app.ministries as m", "m.id", "mm.ministry_id")
        .select(["mm.id", "mm.user_id", "mm.ministry_id", "m.name as ministry_name", "m.slug as ministry_slug", "mm.role", "mm.can_view_investment"])
        .where("mm.user_id", "in", users.map((u) => u.id)).orderBy("m.name").execute()
      : [];
    const rows = users.map((u) => ({
      ...u,
      global_role: u.global_role as GlobalRole,
      agency_global_access: u.agency_global_access as AgencyGlobalAccess,
      status: u.status as UserRow["status"],
      memberships: memberships.filter((m) => m.user_id === u.id).map(({ user_id: _u, ...m }) => ({ ...m, role: m.role as MinistryRole })),
    }));
    return { rows, total: Number(total.n), page, pageSize: PAGE_SIZE };
  });
}

export async function getUser(actor: Actor, userId: string) {
  assertSuperadmin(actor);
  if (!isUuid(userId)) return null;
  const data = await asUser(actor, async (trx) => {
    const user = await trx.selectFrom("app.users")
      .select(["id", "email", "name", "global_role", "agency_global_access", "status", "last_login_at", "created_at", "updated_at"])
      .where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!user) return null;
    const memberships = await trx.selectFrom("app.ministry_memberships as mm").innerJoin("app.ministries as m", "m.id", "mm.ministry_id")
      .select(["mm.id", "mm.ministry_id", "m.name as ministry_name", "m.slug as ministry_slug", "mm.role", "mm.can_view_investment", "m.is_demo", "m.status as ministry_status"])
      .where("mm.user_id", "=", userId).orderBy("m.name").execute();
    const activity = await trx.selectFrom("app.activity_logs").select(["id", "action", "entity_type", "summary", "created_at"])
      .where((eb) => eb.or([eb("actor_user_id", "=", userId), eb.and([eb("entity_type", "=", "user"), eb("entity_id", "=", userId)])]))
      .orderBy("created_at", "desc").limit(15).execute();
    return {
      user: { ...user, global_role: user.global_role as GlobalRole, agency_global_access: user.agency_global_access as AgencyGlobalAccess },
      memberships: memberships.map((m) => ({ ...m, role: m.role as MinistryRole })),
      activity,
    };
  });
  if (!data) return null;
  // Sessões não são legíveis pelo papel da aplicação: contagem via sistema após a verificação acima.
  const sessions = await systemDb().selectFrom("app.sessions").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max("last_seen_at").as("last_seen")])
    .where("user_id", "=", userId).where("revoked_at", "is", null).where("expires_at", ">", new Date()).executeTakeFirstOrThrow();
  return { ...data, activeSessions: Number(sessions.n), lastSeenAt: (sessions.last_seen as Date | null) ?? null };
}

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export function invitationStatus(i: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }, now = new Date()): InvitationStatus {
  if (i.accepted_at) return "accepted";
  if (i.revoked_at) return "revoked";
  if (new Date(i.expires_at).getTime() < now.getTime()) return "expired";
  return "pending";
}

/** Convites (nunca retorna o hash do token). */
export async function listInvitations(actor: Actor, opts: { status?: InvitationStatus; limit?: number } = {}) {
  assertSuperadmin(actor);
  const rows = await asUser(actor, (trx) =>
    trx.selectFrom("app.invitations as i")
      .leftJoin("app.ministries as m", "m.id", "i.ministry_id")
      .leftJoin("app.users as inviter", "inviter.id", "i.invited_by")
      .select([
        "i.id", "i.email", "i.name", "i.global_role", "i.agency_global_access", "i.ministry_id", "i.ministry_role", "i.can_view_investment",
        "i.kind", "i.expires_at", "i.accepted_at", "i.revoked_at", "i.created_at", "m.name as ministry_name", "inviter.name as invited_by_name",
      ])
      .where("i.kind", "=", "invite")
      .orderBy("i.created_at", "desc").limit(opts.limit ?? 100).execute());
  const out = rows.map((r) => ({ ...r, status: invitationStatus(r) }));
  return opts.status ? out.filter((r) => r.status === opts.status) : out;
}

function inviteLink(token: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/convite/${token}`;
}

/**
 * Cria um convite e devolve o link de uso único. O token só existe nesta
 * resposta (o banco guarda apenas o hash): deve ser exibido UMA vez.
 */
export async function inviteUser(actor: Actor, raw: unknown): Promise<{ id: string; link: string; expiresInHours: number }> {
  assertSuperadmin(actor);
  const parsed = invitationInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const input = parsed.data;
  if (input.ministryId) {
    const ministry = await asUser(actor, (trx) => trx.selectFrom("app.ministries").select(["id", "status"]).where("id", "=", input.ministryId!).executeTakeFirst());
    if (!ministry) throw new ServiceError("Ministério não encontrado.", "invalid", { ministryId: ["Ministério não encontrado"] });
    if (ministry.status !== "active") throw new ServiceError("O ministério está arquivado.", "invalid", { ministryId: ["Ministério arquivado"] });
  }
  try {
    // Escrita de convites: sem GRANT ao papel da aplicação (autorização validada acima).
    const { token, id } = await createInvitation(systemDb(), actor.userId, {
      ...input,
      ministryId: input.globalRole === "superadmin" ? null : (input.ministryId ?? null),
      ministryRole: input.globalRole === "superadmin" || !input.ministryId ? null : (input.ministryRole ?? null),
    });
    return { id, link: inviteLink(token), expiresInHours: 72 };
  } catch (error) {
    if (error instanceof AuthError) throw new ServiceError(error.message, "conflict", { email: [error.message] });
    throw error;
  }
}

export async function revokeInvitation(actor: Actor, invitationId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(invitationId)) throw new ServiceError("Convite inválido.", "invalid");
  const db = systemDb();
  const r = await db.updateTable("app.invitations").set({ revoked_at: new Date() })
    .where("id", "=", invitationId).where("accepted_at", "is", null).where("revoked_at", "is", null).executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Convite não encontrado ou já utilizado.", "not_found");
  await auditSystem(db, actor.userId, { entityType: "invitation", entityId: invitationId, action: "invite_revoked", visibility: "admin" });
}

/** Link de redefinição de senha (24 h, uso único) para o administrador repassar. */
export async function createResetLink(actor: Actor, userId: string): Promise<{ link: string; expiresInHours: number }> {
  assertSuperadmin(actor);
  if (!isUuid(userId)) throw new ServiceError("Usuário inválido.", "invalid");
  const user = await asUser(actor, (trx) => trx.selectFrom("app.users").select(["id", "status"]).where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst());
  if (!user) throw new ServiceError("Usuário não encontrado.", "not_found");
  if (user.status === "disabled") throw new ServiceError("Reative o usuário antes de gerar um link de redefinição.", "invalid");
  try {
    const { token } = await createPasswordReset(systemDb(), actor.userId, userId);
    return { link: inviteLink(token), expiresInHours: 24 };
  } catch (error) {
    if (error instanceof AuthError) throw new ServiceError(error.message, "invalid");
    throw error;
  }
}

/** Ativa ou desativa. Desativar encerra imediatamente todas as sessões do usuário. */
export async function setUserStatus(actor: Actor, userId: string, status: "active" | "disabled"): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(userId)) throw new ServiceError("Usuário inválido.", "invalid");
  if (status !== "active" && status !== "disabled") throw new ServiceError("Status inválido.", "invalid");
  if (userId === actor.userId && status === "disabled") throw new ServiceError("Você não pode desativar a sua própria conta.", "forbidden");
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.users").set({ status }).where("id", "=", userId).where("deleted_at", "is", null)
      .returning(["email"]).executeTakeFirst();
    if (!r) throw new ServiceError("Usuário não encontrado.", "not_found");
    await audit(trx, {
      entityType: "user", entityId: userId, action: status === "disabled" ? "user_disabled" : "user_enabled",
      summary: `${status === "disabled" ? "Desativou" : "Reativou"} ${r.email}`, visibility: "admin",
    });
  });
  if (status === "disabled") await revokeAllUserSessions(systemDb(), userId);
}

export const roleInput = z.object({
  globalRole: z.enum(["superadmin", "agency", "ministry"]),
  agencyGlobalAccess: z.enum(["none", "read", "manage"]).default("none"),
}).superRefine((v, ctx) => {
  if (v.globalRole !== "agency" && v.agencyGlobalAccess !== "none") {
    ctx.addIssue({ code: "custom", message: "Visão global só se aplica à equipe da agência", path: ["agencyGlobalAccess"] });
  }
});

/**
 * Altera o papel global. Vínculos incompatíveis com o novo papel (regra do
 * gatilho app.check_membership_role) são removidos ANTES da alteração.
 */
export async function updateUserRole(actor: Actor, userId: string, raw: unknown): Promise<{ removedMemberships: number }> {
  assertSuperadmin(actor);
  if (!isUuid(userId)) throw new ServiceError("Usuário inválido.", "invalid");
  const parsed = roleInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  if (userId === actor.userId) throw new ServiceError("Você não pode alterar o seu próprio papel.", "forbidden");
  const { globalRole, agencyGlobalAccess } = parsed.data;
  return asUser(actor, async (trx) => {
    const before = await trx.selectFrom("app.users").select(["global_role", "agency_global_access", "email"])
      .where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!before) throw new ServiceError("Usuário não encontrado.", "not_found");
    const allowed = compatibleMinistryRoles(globalRole);
    let del = trx.deleteFrom("app.ministry_memberships").where("user_id", "=", userId);
    if (allowed.length) del = del.where("role", "not in", allowed);
    const removed = await del.executeTakeFirst();
    await trx.updateTable("app.users").set({ global_role: globalRole, agency_global_access: globalRole === "agency" ? agencyGlobalAccess : "none" })
      .where("id", "=", userId).execute();
    await audit(trx, {
      entityType: "user", entityId: userId, action: "user_role_changed", visibility: "admin",
      summary: `Papel de ${before.email} alterado`,
      changes: {
        from: { globalRole: before.global_role, agencyGlobalAccess: before.agency_global_access },
        to: { globalRole, agencyGlobalAccess: globalRole === "agency" ? agencyGlobalAccess : "none" },
        removedMemberships: Number(removed.numDeletedRows),
      },
    });
    return { removedMemberships: Number(removed.numDeletedRows) };
  });
}

export const membershipInput = z.object({
  userId: z.uuid("Selecione um usuário"),
  ministryId: z.uuid("Selecione um ministério"),
  role: z.enum(["agency_manager", "agency_viewer", "leader", "operational"], "Selecione o papel"),
  canViewInvestment: z.boolean().default(false),
});

export async function addMembership(actor: Actor, raw: unknown): Promise<string> {
  assertSuperadmin(actor);
  const parsed = membershipInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const input = parsed.data;
  return asUser(actor, async (trx) => {
    const user = await trx.selectFrom("app.users").select(["global_role", "email", "status"]).where("id", "=", input.userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!user) throw new ServiceError("Usuário não encontrado.", "invalid", { userId: ["Usuário não encontrado"] });
    const allowed = compatibleMinistryRoles(user.global_role as GlobalRole);
    if (!allowed.includes(input.role)) {
      throw new ServiceError(user.global_role === "superadmin" ? "Superadministradores não precisam de vínculo com ministérios." : "Papel incompatível com o tipo de usuário.", "invalid", { role: ["Papel incompatível"] });
    }
    const existing = await trx.selectFrom("app.ministry_memberships").select("id").where("user_id", "=", input.userId).where("ministry_id", "=", input.ministryId).executeTakeFirst();
    if (existing) throw new ServiceError("Este usuário já está vinculado ao ministério.", "conflict");
    const row = await trx.insertInto("app.ministry_memberships").values({
      user_id: input.userId, ministry_id: input.ministryId, role: input.role, can_view_investment: input.canViewInvestment, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, {
      ministryId: input.ministryId, entityType: "membership", entityId: row.id, action: "membership_added", visibility: "admin",
      summary: `Vínculo de ${user.email} adicionado`, changes: { userId: input.userId, role: input.role, canViewInvestment: input.canViewInvestment },
    });
    return row.id;
  });
}

export async function updateMembership(actor: Actor, membershipId: string, raw: { role?: unknown; canViewInvestment?: unknown }): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(membershipId)) throw new ServiceError("Vínculo inválido.", "invalid");
  const parsed = z.object({
    role: z.enum(["agency_manager", "agency_viewer", "leader", "operational"]).optional(),
    canViewInvestment: z.boolean().optional(),
  }).safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  await asUser(actor, async (trx) => {
    const m = await trx.selectFrom("app.ministry_memberships as mm").innerJoin("app.users as u", "u.id", "mm.user_id")
      .select(["mm.ministry_id", "mm.role", "mm.can_view_investment", "u.global_role", "u.email"]).where("mm.id", "=", membershipId).executeTakeFirst();
    if (!m) throw new ServiceError("Vínculo não encontrado.", "not_found");
    const role = parsed.data.role ?? (m.role as MinistryRole);
    if (!compatibleMinistryRoles(m.global_role as GlobalRole).includes(role)) throw new ServiceError("Papel incompatível com o tipo de usuário.", "invalid");
    const canViewInvestment = parsed.data.canViewInvestment ?? m.can_view_investment;
    await trx.updateTable("app.ministry_memberships").set({ role, can_view_investment: canViewInvestment }).where("id", "=", membershipId).execute();
    await audit(trx, {
      ministryId: m.ministry_id, entityType: "membership", entityId: membershipId, action: "membership_updated", visibility: "admin",
      summary: `Vínculo de ${m.email} atualizado`,
      changes: { from: { role: m.role, canViewInvestment: m.can_view_investment }, to: { role, canViewInvestment } },
    });
  });
}

export async function removeMembership(actor: Actor, membershipId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(membershipId)) throw new ServiceError("Vínculo inválido.", "invalid");
  await asUser(actor, async (trx) => {
    const m = await trx.deleteFrom("app.ministry_memberships").where("id", "=", membershipId)
      .returning(["ministry_id", "user_id", "role"]).executeTakeFirst();
    if (!m) throw new ServiceError("Vínculo não encontrado.", "not_found");
    await audit(trx, {
      ministryId: m.ministry_id, entityType: "membership", entityId: membershipId, action: "membership_removed", visibility: "admin",
      summary: "Vínculo removido", changes: { userId: m.user_id, role: m.role },
    });
  });
}

/** Encerra as sessões do usuário. Para a própria conta, preserva a sessão atual. */
export async function revokeSessions(actor: Actor, userId: string): Promise<number> {
  assertSuperadmin(actor);
  if (!isUuid(userId)) throw new ServiceError("Usuário inválido.", "invalid");
  const db = systemDb();
  let count: number;
  if (userId === actor.userId) {
    const r = await db.updateTable("app.sessions").set({ revoked_at: new Date() })
      .where("user_id", "=", userId).where("revoked_at", "is", null).where("id", "<>", actor.sessionId).executeTakeFirst();
    count = Number(r.numUpdatedRows);
  } else {
    count = await revokeAllUserSessions(db, userId);
  }
  await auditSystem(db, actor.userId, { entityType: "user", entityId: userId, action: "sessions_revoked", summary: `${count} sessão(ões) encerrada(s)`, visibility: "admin" });
  return count;
}

/**
 * Exclusão lógica: marca deleted_at, desativa, remove vínculos, revoga
 * convites pendentes e encerra sessões. O e-mail fica livre para reuso.
 */
export async function softDeleteUser(actor: Actor, userId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(userId)) throw new ServiceError("Usuário inválido.", "invalid");
  if (userId === actor.userId) throw new ServiceError("Você não pode excluir a sua própria conta.", "forbidden");
  await asUser(actor, async (trx) => {
    const user = await trx.selectFrom("app.users").select(["email"]).where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!user) throw new ServiceError("Usuário não encontrado.", "not_found");
    await trx.deleteFrom("app.ministry_memberships").where("user_id", "=", userId).execute();
    await trx.updateTable("app.users").set({ deleted_at: new Date(), status: "disabled" }).where("id", "=", userId).execute();
    await audit(trx, { entityType: "user", entityId: userId, action: "user_deleted", summary: `Excluiu ${user.email}`, visibility: "admin" });
  });
  const db = systemDb();
  await revokeAllUserSessions(db, userId);
  await db.updateTable("app.invitations").set({ revoked_at: new Date() })
    .where("user_id", "=", userId).where("accepted_at", "is", null).where("revoked_at", "is", null).execute();
}

/** Usuários que podem receber vínculo (exclui superadmins e excluídos). */
export async function membershipCandidates(actor: Actor) {
  assertSuperadmin(actor);
  return asUser(actor, (trx) => trx.selectFrom("app.users").select(["id", "name", "email", "global_role", "status"])
    .where("deleted_at", "is", null).where("global_role", "<>", "superadmin").orderBy("name").execute());
}

