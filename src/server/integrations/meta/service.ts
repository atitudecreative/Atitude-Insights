import type { Database } from "@/server/db";
import { loadCredentials, saveCredentials, type KeyRing } from "../credentials";
import { defaultHttpDeps, IntegrationError, type HttpDeps } from "../http";
import { enqueueJob, type IntegrationConfig } from "../jobs";
import { MetaClient } from "./client";
import { debugToken, exchangeLongLivedToken, exchangeMetaCode, type MetaTokenInfo } from "./oauth";

/**
 * Conexão de contas da Meta.
 *
 * Diferente do Asana, a Meta NÃO oferece refresh token: o token de usuário
 * de longa duração vale ~60 dias e só é renovado quando o usuário passa de
 * novo pelo login (reconectar). Por isso registramos `token_expires_at` e
 * expomos os dias restantes; a interface deve pedir a reconexão antes do
 * vencimento. Tokens de Usuário do Sistema (Business Manager) podem não
 * expirar (`expires_at = 0` no debug_token → token_expires_at nulo).
 */

/** A partir de quantos dias restantes a interface deve alertar para reconectar. */
export const META_TOKEN_RENEWAL_WARNING_DAYS = 10;

export function tokenDaysRemaining(expiresAt: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

interface MeResponse {
  id?: string;
  name?: string;
}

async function fetchMe(token: string, config: IntegrationConfig, version: string, http: HttpDeps): Promise<{ id: string; name: string | null }> {
  const client = new MetaClient({ accessToken: token, version, appSecret: config.metaAppSecret, http, maxAttempts: 2 });
  const me = await client.get<MeResponse>("me", { fields: "id,name" });
  if (!me?.id) throw new IntegrationError("A Meta não identificou o usuário do token", "auth");
  return { id: me.id, name: me.name ?? null };
}

function requireApp(config: IntegrationConfig): { appId: string; appSecret: string } {
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new IntegrationError("Integração com a Meta não configurada (META_APP_ID / META_APP_SECRET)", "invalid_request");
  }
  return { appId: config.metaAppId, appSecret: config.metaAppSecret };
}

function assertValidForApp(info: MetaTokenInfo, appId: string) {
  if (!info.isValid) throw new IntegrationError("Token da Meta inválido ou expirado", "auth");
  if (info.appId && info.appId !== appId) {
    throw new IntegrationError("O token foi emitido para outro app da Meta", "auth");
  }
}

export interface MetaConnectionResult {
  accountId: string;
  jobId: string;
  externalUserName: string | null;
  expiresAt: Date | null;
  daysRemaining: number | null;
}

async function createAccount(
  db: Database,
  input: {
    label: string; authType: "oauth" | "personal_token"; token: string; createdBy: string | null;
    scopes: string[]; expiresAt: Date | null; me: { id: string; name: string | null };
  },
  keys: KeyRing,
): Promise<MetaConnectionResult> {
  const accountId = await db.transaction().execute(async (trx) => {
    const row = await trx.insertInto("app.connected_accounts").values({
      provider: "meta", label: input.label.trim().slice(0, 200) || "Meta", auth_type: input.authType, status: "connected",
      scopes: input.scopes, token_expires_at: input.expiresAt, external_user_id: input.me.id, external_user_name: input.me.name,
      last_tested_at: new Date(), last_test_ok: true, created_by: input.createdBy,
    }).returning("id").executeTakeFirstOrThrow();
    await saveCredentials(trx, row.id, { accessToken: input.token }, keys);
    return row.id;
  });
  const job = await enqueueJob(db, { accountId, provider: "meta", jobType: "meta_discover", trigger: "system", requestedBy: input.createdBy });
  return {
    accountId, jobId: job.id, externalUserName: input.me.name, expiresAt: input.expiresAt,
    daysRemaining: tokenDaysRemaining(input.expiresAt),
  };
}

/**
 * Conclui o OAuth: code → token curto → token longo (~60 dias) → debug_token
 * → /me → conta conectada com credenciais cifradas → job de descoberta.
 * A validação do `state` é responsabilidade da rota de callback.
 */
export async function completeMetaOAuth(
  db: Database,
  input: { code: string; redirectUri: string; label: string; createdBy: string | null },
  keys: KeyRing,
  config: IntegrationConfig,
  version: string,
  http: HttpDeps = defaultHttpDeps,
): Promise<MetaConnectionResult> {
  const app = requireApp(config);
  const short = await exchangeMetaCode({ ...app, redirectUri: input.redirectUri, code: input.code }, version, http);
  const long = await exchangeLongLivedToken({ ...app, accessToken: short.accessToken }, version, http);
  const info = await debugToken({ ...app, inputToken: long.accessToken }, version, http);
  assertValidForApp(info, app.appId);
  const me = await fetchMe(long.accessToken, config, version, http);
  const expiresAt = info.expiresAt ?? (long.expiresIn ? new Date(Date.now() + long.expiresIn * 1000) : null);
  return createAccount(db, {
    label: input.label, authType: "oauth", token: long.accessToken, createdBy: input.createdBy,
    scopes: info.scopes, expiresAt, me,
  }, keys);
}

/**
 * Conecta com um token informado manualmente (ex.: token de Usuário do
 * Sistema gerado no Business Manager). O token é validado ANTES de ser
 * gravado; se for inválido, nada é armazenado.
 */
export async function connectMetaWithToken(
  db: Database,
  input: { label: string; token: string; createdBy: string | null },
  keys: KeyRing,
  config: IntegrationConfig,
  version: string,
  http: HttpDeps = defaultHttpDeps,
): Promise<MetaConnectionResult> {
  const token = input.token.trim();
  if (token.length < 20 || /\s/.test(token)) throw new IntegrationError("Token da Meta em formato inválido", "invalid_request");
  const me = await fetchMe(token, config, version, http);
  let scopes: string[] = [];
  let expiresAt: Date | null = null;
  if (config.metaAppId && config.metaAppSecret) {
    const info = await debugToken({ appId: config.metaAppId, appSecret: config.metaAppSecret, inputToken: token }, version, http);
    assertValidForApp(info, config.metaAppId);
    scopes = info.scopes;
    expiresAt = info.expiresAt;
  }
  return createAccount(db, { label: input.label, authType: "personal_token", token, createdBy: input.createdBy, scopes, expiresAt, me }, keys);
}

export interface MetaConnectionTest {
  ok: boolean;
  status: "connected" | "expired" | "error";
  message: string;
  externalUserName: string | null;
  expiresAt: Date | null;
  daysRemaining: number | null;
}

/** Testa a conexão e atualiza last_tested_at / last_test_ok / status / last_error. */
export async function testMetaConnection(
  db: Database,
  accountId: string,
  keys: KeyRing,
  config: IntegrationConfig,
  version: string,
  http: HttpDeps = defaultHttpDeps,
  now: Date = new Date(),
): Promise<MetaConnectionTest> {
  const account = await db.selectFrom("app.connected_accounts").select(["id", "provider", "status", "token_expires_at"])
    .where("id", "=", accountId).executeTakeFirst();
  if (!account || account.provider !== "meta") throw new IntegrationError("Conta da Meta não encontrada", "not_found");

  let expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
  let result: MetaConnectionTest;
  const finish = async (r: MetaConnectionTest, extra: { scopes?: string[]; tokenExpiresAt?: Date | null; userName?: string | null } = {}) => {
    const keepSyncing = r.status === "connected" && account.status === "syncing";
    await db.updateTable("app.connected_accounts").set({
      last_tested_at: now, last_test_ok: r.ok, status: keepSyncing ? "syncing" : r.status,
      last_error: r.ok ? null : r.message.slice(0, 500), ...(r.ok ? {} : { last_error_at: now }),
      ...(extra.scopes ? { scopes: extra.scopes } : {}),
      ...(extra.tokenExpiresAt !== undefined ? { token_expires_at: extra.tokenExpiresAt } : {}),
      ...(extra.userName ? { external_user_name: extra.userName } : {}),
    }).where("id", "=", accountId).execute();
    return r;
  };

  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return finish({
      ok: false, status: "expired", externalUserName: null, expiresAt, daysRemaining: tokenDaysRemaining(expiresAt, now),
      message: `O token da Meta expirou em ${expiresAt.toISOString().slice(0, 10)} — reconecte a conta`,
    });
  }

  let credentials;
  try {
    credentials = await loadCredentials(db, accountId, keys);
  } catch {
    credentials = null;
  }
  if (!credentials) {
    return finish({ ok: false, status: "error", message: "Credenciais ausentes ou ilegíveis", externalUserName: null, expiresAt, daysRemaining: null });
  }

  try {
    const me = await fetchMe(credentials.accessToken, config, version, http);
    let scopes: string[] | undefined;
    if (config.metaAppId && config.metaAppSecret) {
      const info = await debugToken({ appId: config.metaAppId, appSecret: config.metaAppSecret, inputToken: credentials.accessToken }, version, http);
      assertValidForApp(info, config.metaAppId);
      scopes = info.scopes;
      expiresAt = info.expiresAt;
    }
    const days = tokenDaysRemaining(expiresAt, now);
    const warn = days !== null && days <= META_TOKEN_RENEWAL_WARNING_DAYS;
    result = {
      ok: true, status: "connected", externalUserName: me.name, expiresAt, daysRemaining: days,
      message: days === null
        ? "Conexão com a Meta funcionando (token sem data de expiração)"
        : `Conexão com a Meta funcionando — o token expira em ${days} dia(s)${warn ? "; reconecte em breve" : ""}`,
    };
    return finish(result, { scopes, tokenExpiresAt: scopes ? expiresAt : undefined, userName: me.name });
  } catch (error) {
    const err = error instanceof IntegrationError ? error : new IntegrationError((error as Error).message, "permanent");
    return finish({
      ok: false, status: err.kind === "auth" ? "expired" : "error", message: err.message, externalUserName: null,
      expiresAt, daysRemaining: tokenDaysRemaining(expiresAt, now),
    });
  }
}
