import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { systemDb } from "@/server/db";
import { env, isProduction } from "@/server/env";
import { SESSION_COOKIE, validateSessionToken, type SessionPolicy } from "./sessions";
import { hasGlobalManage, hasGlobalRead, type Actor } from "./types";

export function sessionPolicy(): SessionPolicy {
  return { idleHours: env().SESSION_IDLE_HOURS, absoluteDays: env().SESSION_ABSOLUTE_DAYS };
}

/** Usuário da requisição atual (validado no banco a cada requisição). */
export const getActor = cache(async (): Promise<Actor | null> => {
  const store = await cookies();
  return validateSessionToken(systemDb(), store.get(SESSION_COOKIE)?.value, sessionPolicy());
});

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}

/** Áreas globais: retorna 404 (não revela a existência da página). */
export async function requireSuperadmin(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.globalRole !== "superadmin") notFound();
  return actor;
}

export async function requireGlobalRead(): Promise<Actor> {
  const actor = await requireActor();
  if (!hasGlobalRead(actor)) notFound();
  return actor;
}

export async function requireGlobalManage(): Promise<Actor> {
  const actor = await requireActor();
  if (!hasGlobalManage(actor)) notFound();
  return actor;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction() || env().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}
