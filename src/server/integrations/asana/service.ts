import type { Database } from "@/server/db";
import { loadCredentials, saveCredentials, type KeyRing, type StoredCredentials } from "../credentials";
import { defaultHttpDeps, IntegrationError, type HttpDeps } from "../http";
import { enqueueJob, type IntegrationConfig, type JobContext } from "../jobs";
import { AsanaClient, type AsanaUser, type AsanaWorkspace } from "./client";
import { refreshAsanaToken, exchangeAsanaCode, type AsanaTokenResponse } from "./oauth";

/** Valida um token chamando /users/me. Lança IntegrationError se inválido. */
export async function testAsanaToken(token: string, http: HttpDeps = defaultHttpDeps): Promise<{ gid: string; name: string; workspaces: AsanaWorkspace[] }> {
  const trimmed = token.trim();
  if (!trimmed) throw new IntegrationError("Informe o token de acesso do Asana", "invalid_request");
  const me = await new AsanaClient(trimmed, http).getMe();
  return { gid: me.gid, name: me.name, workspaces: me.workspaces };
}

function expiresAt(response: AsanaTokenResponse): Date | null {
  return typeof response.expires_in === "number" ? new Date(Date.now() + response.expires_in * 1000) : null;
}

async function createAccount(
  db: Database,
  input: { label: string; createdBy: string | null; authType: "oauth" | "personal_token"; me: AsanaUser; credentials: StoredCredentials; tokenExpiresAt: Date | null },
  keys: KeyRing,
): Promise<string> {
  const label = input.label.trim() || `Asana — ${input.me.name}`;
  return db.transaction().execute(async (trx) => {
    const account = await trx.insertInto("app.connected_accounts").values({
      provider: "asana", label, auth_type: input.authType, status: "connected",
      external_user_id: input.me.gid, external_user_name: input.me.name,
      last_tested_at: new Date(), last_test_ok: true, token_expires_at: input.tokenExpiresAt,
      created_by: input.createdBy,
    }).returning("id").executeTakeFirstOrThrow();
    await saveCredentials(trx, account.id, input.credentials, keys);
    await enqueueJob(trx, { accountId: account.id, provider: "asana", jobType: "asana_discover", trigger: "system", requestedBy: input.createdBy });
    return account.id;
  });
}

/**
 * Conecta uma conta via Personal Access Token. O token é validado ANTES de
 * qualquer gravação: tokens inválidos nunca são armazenados.
 */
export async function connectAsanaWithToken(
  db: Database,
  input: { label: string; token: string; createdBy: string | null },
  keys: KeyRing,
  http: HttpDeps = defaultHttpDeps,
): Promise<string> {
  const token = input.token.trim();
  if (!token) throw new IntegrationError("Informe o token de acesso do Asana", "invalid_request");
  const me = await new AsanaClient(token, http).getMe();
  return createAccount(db, {
    label: input.label, createdBy: input.createdBy, authType: "personal_token", me,
    credentials: { accessToken: token }, tokenExpiresAt: null,
  }, keys);
}

function requireOAuthConfig(config: IntegrationConfig): { clientId: string; clientSecret: string } {
  if (!config.asanaClientId || !config.asanaClientSecret) {
    throw new IntegrationError("OAuth do Asana não configurado (ASANA_CLIENT_ID/ASANA_CLIENT_SECRET)", "permanent");
  }
  return { clientId: config.asanaClientId, clientSecret: config.asanaClientSecret };
}

/** Conclui o fluxo OAuth: troca o código, valida e grava a conta. */
export async function completeAsanaOAuth(
  db: Database,
  input: { code: string; codeVerifier: string; redirectUri: string; label: string; createdBy: string | null },
  keys: KeyRing,
  config: IntegrationConfig,
  http: HttpDeps = defaultHttpDeps,
): Promise<string> {
  const { clientId, clientSecret } = requireOAuthConfig(config);
  const token = await exchangeAsanaCode({ clientId, clientSecret, redirectUri: input.redirectUri, code: input.code, codeVerifier: input.codeVerifier }, http);
  const me = await new AsanaClient(token.access_token, http).getMe();
  return createAccount(db, {
    label: input.label, createdBy: input.createdBy, authType: "oauth", me,
    credentials: { accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}) },
    tokenExpiresAt: expiresAt(token),
  }, keys);
}

/** Contexto mínimo para chamadas autenticadas (compatível com JobContext). */
export interface AsanaAuthContext {
  db: Database;
  accountId: string;
  authType: string;
  /** Mutável: é atualizado quando o token é renovado. */
  credentials: StoredCredentials;
  keys: KeyRing;
  config: IntegrationConfig;
  http: HttpDeps;
}

export function asanaAuthFromJob(ctx: JobContext): AsanaAuthContext {
  return {
    db: ctx.db, accountId: ctx.account.id, authType: ctx.account.auth_type, credentials: ctx.credentials,
    keys: ctx.keys, config: ctx.config, http: ctx.http,
  };
}

/** Renova o access token OAuth e grava as novas credenciais cifradas. */
async function refreshAccountToken(auth: AsanaAuthContext): Promise<void> {
  const refreshToken = auth.credentials.refreshToken;
  if (!refreshToken) throw new IntegrationError("Asana: token expirado e sem refresh token — reconecte a conta", "auth", 401);
  const { clientId, clientSecret } = requireOAuthConfig(auth.config);
  const response = await refreshAsanaToken({ clientId, clientSecret, refreshToken }, auth.http);
  const next: StoredCredentials = {
    ...auth.credentials,
    accessToken: response.access_token,
    // O Asana normalmente mantém o mesmo refresh token; usa o novo se vier.
    refreshToken: response.refresh_token ?? refreshToken,
  };
  await saveCredentials(auth.db, auth.accountId, next, auth.keys);
  await auth.db.updateTable("app.connected_accounts").set({ token_expires_at: expiresAt(response) })
    .where("id", "=", auth.accountId).execute();
  auth.credentials.accessToken = next.accessToken;
  auth.credentials.refreshToken = next.refreshToken;
}

/**
 * Executa `fn` com um cliente autenticado. Em contas OAuth, um erro de
 * autenticação provoca UMA renovação do token e nova tentativa; contas com
 * token pessoal apenas propagam o erro.
 */
export async function withAsanaAuth<T>(auth: AsanaAuthContext, fn: (client: AsanaClient) => Promise<T>): Promise<T> {
  try {
    return await fn(new AsanaClient(auth.credentials.accessToken, auth.http));
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.kind !== "auth" || auth.authType !== "oauth") throw error;
  }
  await refreshAccountToken(auth);
  return fn(new AsanaClient(auth.credentials.accessToken, auth.http));
}

/** Testa a conexão de uma conta existente e registra o resultado. */
export async function testAsanaConnection(
  db: Database,
  accountId: string,
  keys: KeyRing,
  config: IntegrationConfig,
  http: HttpDeps = defaultHttpDeps,
): Promise<{ ok: boolean; message: string }> {
  const account = await db.selectFrom("app.connected_accounts").select(["id", "provider", "auth_type", "status"])
    .where("id", "=", accountId).executeTakeFirst();
  if (!account || account.provider !== "asana") return { ok: false, message: "Conta do Asana não encontrada" };

  const fail = async (message: string, status: "expired" | "error") => {
    await db.updateTable("app.connected_accounts").set({
      last_tested_at: new Date(), last_test_ok: false, status, last_error: message.slice(0, 500), last_error_at: new Date(),
    }).where("id", "=", accountId).execute();
    return { ok: false, message };
  };

  let credentials: StoredCredentials | null;
  try {
    credentials = await loadCredentials(db, accountId, keys);
  } catch {
    credentials = null;
  }
  if (!credentials) return fail("Credenciais ausentes ou ilegíveis — reconecte a conta", "error");

  try {
    const me = await withAsanaAuth({ db, accountId, authType: account.auth_type, credentials, keys, config, http }, (client) => client.getMe());
    await db.updateTable("app.connected_accounts").set({
      last_tested_at: new Date(), last_test_ok: true, last_error: null, external_user_id: me.gid, external_user_name: me.name,
      // Não interrompe o estado "sincronizando" de um job em andamento.
      ...(account.status === "syncing" ? {} : { status: "connected" }),
    }).where("id", "=", accountId).execute();
    return { ok: true, message: `Conectado como ${me.name} (${me.workspaces.length} workspace(s))` };
  } catch (error) {
    const err = error instanceof IntegrationError ? error : new IntegrationError((error as Error).message ?? "Erro inesperado", "permanent");
    return fail(err.message, err.kind === "auth" ? "expired" : "error");
  }
}
