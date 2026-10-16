import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { systemDb } from "@/server/db";
import { env } from "@/server/env";
import { auditSystem } from "@/server/audit";
import { getActor } from "@/server/auth/current";
import type { Actor } from "@/server/auth/types";
import { buildAsanaAuthorizeUrl, createPkceChallenge, createPkceVerifier } from "@/server/integrations/asana/oauth";
import { completeAsanaOAuth } from "@/server/integrations/asana/service";
import { buildMetaAuthorizeUrl } from "@/server/integrations/meta/oauth";
import { completeMetaOAuth } from "@/server/integrations/meta/service";
import { redactSecrets } from "@/server/security/crypto";
import { consumeOAuthState, createOAuthState, integrationRuntime, oauthRedirectUri, type Provider } from "./integrations-admin";

/**
 * Fluxo OAuth (início e retorno) compartilhado pelas rotas
 * /api/integrations/{asana|meta}/{start|callback}. Proteções:
 *  - somente superadministradores com sessão válida;
 *  - `state` aleatório de uso único (hash em app.oauth_states, 10 min,
 *    vinculado ao usuário) — CSRF;
 *  - PKCE (S256) no Asana;
 *  - redirecionamentos de erro com mensagens genéricas (sem segredos).
 */

const back = (query: string) => NextResponse.redirect(new URL(`/admin/integracoes?${query}`, env().APP_URL), { status: 303 });

function configured(provider: Provider): boolean {
  const e = env();
  return provider === "asana" ? Boolean(e.ASANA_CLIENT_ID && e.ASANA_CLIENT_SECRET) : Boolean(e.META_APP_ID && e.META_APP_SECRET);
}

async function superadmin(): Promise<Actor | null> {
  const actor = await getActor();
  return actor && actor.globalRole === "superadmin" ? actor : null;
}

export async function oauthStart(provider: Provider, req: NextRequest): Promise<NextResponse> {
  const actor = await superadmin();
  if (!actor) return new NextResponse("Não encontrado", { status: 404 });
  if (!configured(provider)) return back("erro=config");
  const label = req.nextUrl.searchParams.get("label")?.slice(0, 120) ?? null;
  const e = env();
  if (provider === "asana") {
    const verifier = createPkceVerifier();
    const state = await createOAuthState(actor, provider, { label, codeVerifier: verifier });
    return NextResponse.redirect(buildAsanaAuthorizeUrl({
      clientId: e.ASANA_CLIENT_ID!, redirectUri: oauthRedirectUri("asana"), state, codeChallenge: createPkceChallenge(verifier),
    }), { status: 303 });
  }
  const state = await createOAuthState(actor, provider, { label });
  return NextResponse.redirect(buildMetaAuthorizeUrl({
    appId: e.META_APP_ID!, redirectUri: oauthRedirectUri("meta"), state, version: e.META_GRAPH_VERSION,
  }), { status: 303 });
}

export async function oauthCallback(provider: Provider, req: NextRequest): Promise<NextResponse> {
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(new URL("/login", env().APP_URL), { status: 303 });
  if (actor.globalRole !== "superadmin") return new NextResponse("Não encontrado", { status: 404 });
  const sp = req.nextUrl.searchParams;
  // Consome o estado ANTES de qualquer outra coisa (inclusive em caso de erro do provedor).
  const state = await consumeOAuthState(actor, provider, sp.get("state"));
  if (!state) return back("erro=estado");
  if (sp.get("error")) return back("erro=negado");
  const code = sp.get("code");
  if (!code || code.length > 2000) return back("erro=falha");
  if (!configured(provider)) return back("erro=config");

  const { keys, config, graphVersion } = integrationRuntime();
  const db = systemDb();
  try {
    let accountId: string;
    if (provider === "asana") {
      if (!state.codeVerifier) return back("erro=estado");
      accountId = await completeAsanaOAuth(db, {
        code, codeVerifier: state.codeVerifier, redirectUri: oauthRedirectUri("asana"), label: state.label ?? "", createdBy: actor.userId,
      }, keys, config);
    } else {
      accountId = (await completeMetaOAuth(db, {
        code, redirectUri: oauthRedirectUri("meta"), label: state.label ?? "Meta", createdBy: actor.userId,
      }, keys, config, graphVersion)).accountId;
    }
    await auditSystem(db, actor.userId, {
      entityType: "connected_account", entityId: accountId, action: "integration_connected", visibility: "admin",
      summary: `Conta ${provider === "asana" ? "do Asana" : "da Meta"} conectada via OAuth`, changes: { provider, authType: "oauth" },
    });
    return back(`ok=${provider}`);
  } catch (error) {
    console.error(`[oauth:${provider}]`, redactSecrets((error as Error).message ?? "erro"));
    await auditSystem(db, actor.userId, { entityType: "connected_account", action: "integration_oauth_failed", visibility: "admin", changes: { provider } });
    return back("erro=falha");
  }
}
