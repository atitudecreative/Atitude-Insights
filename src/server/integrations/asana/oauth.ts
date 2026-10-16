import { createHash, randomBytes } from "node:crypto";
import { defaultHttpDeps, IntegrationError, parseRetryAfter, requestJson, type HttpDeps } from "../http";

/**
 * OAuth 2.0 do Asana (authorization code + PKCE S256).
 * Docs: https://developers.asana.com/docs/oauth
 */
export const ASANA_AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize";
export const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";

/** Gera um code_verifier PKCE (43–128 caracteres, base64url). */
export function createPkceVerifier(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}

/** code_challenge = BASE64URL(SHA256(code_verifier)). */
export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAsanaAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Escopos granulares opcionais (apps com "permissões completas" não precisam). */
  scopes?: string[];
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    code_challenge_method: "S256",
    code_challenge: input.codeChallenge,
  });
  if (input.scopes && input.scopes.length > 0) params.set("scope", input.scopes.join(" "));
  return `${ASANA_AUTHORIZE_URL}?${params.toString()}`;
}

export interface AsanaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  data?: { id?: number | string; gid?: string; name?: string; email?: string };
}

function classifyOAuthError(status: number, body: unknown, headers: Headers): IntegrationError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; error_description?: unknown };
  const code = typeof b.error === "string" ? b.error : undefined;
  const description = typeof b.error_description === "string" ? b.error_description : undefined;
  const message = `Asana OAuth: ${description ?? code ?? `HTTP ${status}`}`;
  if (status === 429) return new IntegrationError(message, "rate_limit", status, code, parseRetryAfter(headers) ?? 60_000);
  if (status >= 500) return new IntegrationError(message, "transient", status, code);
  // invalid_grant = código/refresh token inválido, expirado ou revogado.
  if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client" || status === 401) {
    return new IntegrationError(message, "auth", status, code);
  }
  if (status === 403) return new IntegrationError(message, "permission", status, code);
  return new IntegrationError(message, "invalid_request", status, code);
}

async function postToken(form: Record<string, string | undefined>, http: HttpDeps): Promise<AsanaTokenResponse> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) if (value !== undefined) body.set(key, value);
  const response = await requestJson<AsanaTokenResponse>(ASANA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Trocas de código não devem ser repetidas em excesso (código de uso único).
    maxAttempts: 2,
    classifyError: classifyOAuthError,
  }, http);
  if (!response?.access_token) throw new IntegrationError("Asana OAuth: resposta sem access_token", "permanent");
  return response;
}

export function exchangeAsanaCode(
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
  http: HttpDeps = defaultHttpDeps,
): Promise<AsanaTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  }, http);
}

export function refreshAsanaToken(
  input: { clientId: string; clientSecret: string; refreshToken: string; redirectUri?: string },
  http: HttpDeps = defaultHttpDeps,
): Promise<AsanaTokenResponse> {
  return postToken({
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    redirect_uri: input.redirectUri,
  }, http);
}
