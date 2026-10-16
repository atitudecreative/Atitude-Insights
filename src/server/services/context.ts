import { sql, withUserDb, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/types";

/** Executa consultas no contexto RLS do usuário autenticado. */
export function asUser<T>(actor: Actor, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return withUserDb(actor.userId, fn);
}

export interface MinistryAccess {
  canRead: boolean;
  canManage: boolean;
  canViewInvestment: boolean;
  canCollaborate: boolean;
  role: string | null;
}

/** Permissões efetivas calculadas pelas MESMAS funções usadas nas políticas RLS. */
export async function ministryAccess(trx: Tx, ministryId: string | null): Promise<MinistryAccess> {
  const r = await sql<{ r: boolean; m: boolean; i: boolean; c: boolean; role: string | null }>`
    select app.can_read_ministry(${ministryId}::uuid) as r, app.can_manage_ministry(${ministryId}::uuid) as m,
           app.can_view_investment(${ministryId}::uuid) as i, app.can_collaborate(${ministryId}::uuid) as c,
           app.membership_role(${ministryId}::uuid) as role`.execute(trx);
  const row = r.rows[0]!;
  return { canRead: row.r, canManage: row.m, canViewInvestment: row.i, canCollaborate: row.c, role: row.role };
}

export class ServiceError extends Error {
  constructor(message: string, public readonly code: "not_found" | "forbidden" | "invalid" | "conflict" = "invalid", public readonly fieldErrors?: Record<string, string[]>) {
    super(message);
  }
}

export interface ActionState {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string[]>;
  redirectTo?: string;
}

/** Traduz erros conhecidos do banco em mensagens seguras (sem detalhes internos). */
export function toActionError(error: unknown): ActionState {
  if (error instanceof ServiceError) return { ok: false, message: error.message, errors: error.fieldErrors };
  const e = error as { code?: string; message?: string };
  if (e?.code === "42501" || /row-level security|permission denied/i.test(e?.message ?? "")) {
    return { ok: false, message: "Você não tem permissão para esta operação." };
  }
  if (e?.code === "23505") return { ok: false, message: "Já existe um registro com estes dados." };
  if (e?.code === "23514" || e?.code === "P0001") {
    const msg = e.message ?? "";
    return { ok: false, message: /[À-ú]/.test(msg) || msg.length < 160 ? msg.replace(/^.*?: /, "") : "Dados inválidos." };
  }
  if (e?.code === "23503") return { ok: false, message: "Registro relacionado não encontrado." };
  console.error("[action]", e?.code, e?.message);
  return { ok: false, message: "Não foi possível concluir a operação. Tente novamente." };
}

export function zodErrors(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? "_");
    (out[k] ??= []).push(i.message);
  }
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
