"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { acceptInvitation, AuthError, login } from "@/server/auth/service";
import { clearSessionCookie, getActor, requestMeta, sessionPolicy, setSessionCookie } from "@/server/auth/current";
import { revokeSessionByToken, SESSION_COOKIE } from "@/server/auth/sessions";
import { auditSystem } from "@/server/audit";
import { systemDb } from "@/server/db";
import { cookies } from "next/headers";
import type { ActionState } from "@/server/services/context";

const loginSchema = z.object({
  email: z.email("Informe um e-mail válido").max(200),
  password: z.string().min(1, "Informe a senha").max(200),
  next: z.string().optional(),
});

function safeNext(next: string | undefined): string {
  // Evita open redirect: apenas caminhos internos.
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export async function loginAction(_: ActionState | null, form: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({ email: form.get("email"), password: form.get("password"), next: form.get("next") ?? undefined });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  try {
    const meta = await requestMeta();
    const session = await login(systemDb(), { email: parsed.data.email, password: parsed.data.password, ...meta }, sessionPolicy());
    await setSessionCookie(session.token, session.expiresAt);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    console.error("[login]", (error as Error).message);
    return { ok: false, message: "Não foi possível entrar agora. Tente novamente." };
  }
  redirect(safeNext(parsed.data.next));
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const actor = await getActor();
  if (token) await revokeSessionByToken(systemDb(), token);
  if (actor) await auditSystem(systemDb(), actor.userId, { entityType: "auth", entityId: actor.userId, action: "logout" });
  await clearSessionCookie();
  redirect("/login");
}

const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(200),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: "As senhas não conferem", path: ["confirm"] });

export async function acceptInviteAction(_: ActionState | null, form: FormData): Promise<ActionState> {
  const parsed = acceptSchema.safeParse({ token: form.get("token"), password: form.get("password"), confirm: form.get("confirm") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  try {
    const meta = await requestMeta();
    const session = await acceptInvitation(systemDb(), parsed.data.token, parsed.data.password, sessionPolicy(), meta);
    await setSessionCookie(session.token, session.expiresAt);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    console.error("[invite]", (error as Error).message);
    return { ok: false, message: "Não foi possível concluir. Tente novamente." };
  }
  redirect("/");
}
