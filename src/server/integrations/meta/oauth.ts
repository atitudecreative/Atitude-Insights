import { defaultHttpDeps, IntegrationError, requestJson, type HttpDeps } from "../http";
import { classifyMetaError, graphBaseUrl } from "./client";

/**
 * Permissões mínimas solicitadas no login (ver docs/integrations/meta.md):
 * - ads_read: leitura de campanhas, conjuntos, anúncios e insights de anúncios;
 * - pages_show_list: listar as Páginas que o usuário administra;
 * - pages_read_engagement: ler publicações, reações e comentários das Páginas;
 * - read_insights: métricas (insights) das Páginas e publicações;
 * - instagram_basic: perfil e mídias da conta profissional do Instagram;
 * - instagram_manage_insights: métricas do Instagram (alcance, visualizações...);
 * - business_management: ativos pertencentes a um Business Manager.
 */
export const DEFAULT_META_SCOPES = [
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "business_management",
] as const;

export function buildMetaAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  version?: string;
}): string {
  const version = input.version ?? "v23.0";
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...(input.scopes ?? DEFAULT_META_SCOPES)].join(","));
  return url.toString();
}

export interface MetaTokenResponse {
  accessToken: string;
  tokenType?: string;
  /** Segundos até expirar (ausente para tokens sem expiração). */
  expiresIn?: number;
}

interface RawTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

function toTokenResponse(raw: RawTokenResponse): MetaTokenResponse {
  if (!raw?.access_token) throw new IntegrationError("A Meta não retornou um token de acesso", "auth");
  return {
    accessToken: raw.access_token,
    tokenType: raw.token_type,
    expiresIn: typeof raw.expires_in === "number" ? raw.expires_in : undefined,
  };
}

function oauthUrl(version: string, params: Record<string, string>): string {
  const url = new URL(`${graphBaseUrl(version)}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Troca o `code` do callback por um token de curta duração (~1–2 h). */
export async function exchangeMetaCode(
  input: { appId: string; appSecret: string; redirectUri: string; code: string },
  version: string,
  http: HttpDeps = defaultHttpDeps,
): Promise<MetaTokenResponse> {
  const url = oauthUrl(version, {
    client_id: input.appId, client_secret: input.appSecret, redirect_uri: input.redirectUri, code: input.code,
  });
  // O código é de uso único: não repetir em caso de erro.
  const raw = await requestJson<RawTokenResponse>(url, { maxAttempts: 1, classifyError: classifyMetaError }, http);
  return toTokenResponse(raw);
}

/** Troca um token de curta duração por um de longa duração (~60 dias). */
export async function exchangeLongLivedToken(
  input: { appId: string; appSecret: string; accessToken: string },
  version: string,
  http: HttpDeps = defaultHttpDeps,
): Promise<MetaTokenResponse> {
  const url = oauthUrl(version, {
    grant_type: "fb_exchange_token", client_id: input.appId, client_secret: input.appSecret, fb_exchange_token: input.accessToken,
  });
  const raw = await requestJson<RawTokenResponse>(url, { maxAttempts: 2, classifyError: classifyMetaError }, http);
  return toTokenResponse(raw);
}

export interface MetaTokenInfo {
  isValid: boolean;
  scopes: string[];
  /** null = o token não expira (ex.: token de Usuário do Sistema). */
  expiresAt: Date | null;
  /** Fim do acesso a dados (renovado a cada uso do app pelo usuário). */
  dataAccessExpiresAt: Date | null;
  userId: string | null;
  appId: string | null;
  type: string | null;
}

interface RawDebugToken {
  data?: {
    app_id?: string;
    type?: string;
    is_valid?: boolean;
    expires_at?: number;
    data_access_expires_at?: number;
    scopes?: string[];
    user_id?: string;
  };
}

const fromUnix = (value: number | undefined): Date | null => (typeof value === "number" && value > 0 ? new Date(value * 1000) : null);

/** Inspeciona um token com o token de app (`appId|appSecret`). */
export async function debugToken(
  input: { appId: string; appSecret: string; inputToken: string },
  version: string,
  http: HttpDeps = defaultHttpDeps,
): Promise<MetaTokenInfo> {
  const url = new URL(`${graphBaseUrl(version)}/debug_token`);
  url.searchParams.set("input_token", input.inputToken);
  url.searchParams.set("access_token", `${input.appId}|${input.appSecret}`);
  const raw = await requestJson<RawDebugToken>(url.toString(), { maxAttempts: 3, classifyError: classifyMetaError }, http);
  const data = raw?.data ?? {};
  return {
    isValid: data.is_valid === true,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    expiresAt: fromUnix(data.expires_at),
    dataAccessExpiresAt: fromUnix(data.data_access_expires_at),
    userId: data.user_id ?? null,
    appId: data.app_id ?? null,
    type: data.type ?? null,
  };
}
