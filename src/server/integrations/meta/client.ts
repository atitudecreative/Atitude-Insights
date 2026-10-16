import { createHmac } from "node:crypto";
import { defaultHttpDeps, IntegrationError, parseRetryAfter, requestJson, type HttpDeps, type IntegrationErrorKind } from "../http";

/**
 * Cliente da Graph API da Meta (Marketing API + Instagram/Facebook orgânico).
 * - O token vai no cabeçalho Authorization (ou, opcionalmente, em
 *   `access_token`), nunca em mensagens de erro ou logs.
 * - Quando o App Secret está configurado, envia `appsecret_proof`
 *   (HMAC-SHA256 do token com o segredo do app), exigido por apps com
 *   "Require App Secret" ativado.
 * - Repetições: falhas temporárias e limites de taxa curtos são repetidos
 *   aqui; limites longos sobem como IntegrationError('rate_limit') com
 *   retryAfterMs para que a fila reagende o job sem prender o processo.
 */

export const GRAPH_HOST = "https://graph.facebook.com";

export function graphBaseUrl(version: string): string {
  return `${GRAPH_HOST}/${version}`;
}

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/** Erro da Graph API com o subcódigo e o fbtrace_id (úteis no suporte da Meta). */
export class MetaApiError extends IntegrationError {
  constructor(
    message: string,
    kind: IntegrationErrorKind,
    status?: number,
    providerCode?: number,
    retryAfterMs?: number,
    public readonly subcode?: number,
    public readonly fbtraceId?: string,
  ) {
    super(message, kind, status, providerCode, retryAfterMs);
    this.name = "MetaApiError";
  }
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

/** Subcódigos documentados de limite de taxa (contas de anúncios / Business Use Case). */
const RATE_LIMIT_SUBCODES = new Set([1487742, 1487225, 1504022, 1504039, 2446079]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/**
 * Extrai o tempo estimado para recuperar o acesso dos cabeçalhos de uso da
 * Meta (X-Business-Use-Case-Usage em minutos; X-Ad-Account-Usage em segundos).
 */
export function metaUsageRetryAfterMs(headers: Headers): number | undefined {
  let best: number | undefined;
  const consider = (ms: number) => {
    if (Number.isFinite(ms) && ms > 0) best = Math.max(best ?? 0, ms);
  };
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      for (const entries of Object.values(parsed)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (typeof entry.estimated_time_to_regain_access === "number") consider(entry.estimated_time_to_regain_access * 60_000);
        }
      }
    } catch {
      // cabeçalho malformado: ignora
    }
  }
  const adAccount = headers.get("x-ad-account-usage");
  if (adAccount) {
    try {
      const parsed = JSON.parse(adAccount) as { reset_time_duration?: number };
      if (typeof parsed.reset_time_duration === "number") consider(parsed.reset_time_duration * 1000);
    } catch {
      // ignora
    }
  }
  return best;
}

/** Converte a resposta de erro da Graph API em um erro normalizado. */
export function classifyMetaError(status: number, body: unknown, headers: Headers): MetaApiError {
  const error = (body as MetaErrorBody | undefined)?.error;
  const code = typeof error?.code === "number" ? error.code : undefined;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : undefined;
  const detail = error?.message ? `: ${error.message}` : "";
  const suffix = code !== undefined ? ` (código ${code}${subcode !== undefined ? `/${subcode}` : ""})` : ` (HTTP ${status})`;
  const make = (kind: IntegrationErrorKind, prefix: string, retryAfterMs?: number) =>
    new MetaApiError(`${prefix}${suffix}${detail}`, kind, status, code, retryAfterMs, subcode, error?.fbtrace_id);

  if (code === 190 || code === 102 || (code === undefined && status === 401)) {
    return make("auth", "Token da Meta inválido ou expirado — reconecte a conta");
  }
  const isRateLimit = status === 429 || (code !== undefined && (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014)))
    || (subcode !== undefined && RATE_LIMIT_SUBCODES.has(subcode));
  if (isRateLimit) {
    const retryAfter = parseRetryAfter(headers) ?? metaUsageRetryAfterMs(headers);
    return make("rate_limit", "Limite de requisições da Meta atingido", retryAfter);
  }
  if (code === 10 || code === 3 || (code !== undefined && code >= 200 && code <= 299) || (code === undefined && status === 403)) {
    return make("permission", "Permissão insuficiente na Meta");
  }
  if (code === 1 || code === 2 || error?.is_transient === true || status >= 500) {
    return make("transient", "Falha temporária na Meta");
  }
  if (code === 803 || (code === undefined && status === 404)) {
    return make("not_found", "Objeto não encontrado na Meta");
  }
  if (code === 100 || status === 400) {
    return make("invalid_request", "Requisição inválida para a Meta");
  }
  return make("permanent", "Erro da Meta");
}

export type GraphParams = Record<string, string | number | boolean | undefined | null>;

/** Continuação de paginação: parâmetros a mesclar na próxima requisição (serializável). */
export type PageCursor = Record<string, string>;

export interface GraphPage<T> {
  data: T[];
  /** null quando não há próxima página. */
  next: PageCursor | null;
}

interface GraphListResponse<T> {
  data?: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
}

export interface MetaClientOptions {
  accessToken: string;
  version: string;
  /** Quando presente, envia appsecret_proof em toda requisição. */
  appSecret?: string;
  http?: HttpDeps;
  /** Onde enviar o token. Padrão: cabeçalho Authorization. */
  tokenIn?: "header" | "query";
  /** Tentativas totais por requisição (falhas temporárias / limite curto). */
  maxAttempts?: number;
  /** Espera máxima aceitável dentro do processo para um limite de taxa. */
  maxInlineWaitMs?: number;
}

const SENSITIVE_QUERY = new Set(["access_token", "appsecret_proof"]);

/** Parâmetros da URL `paging.next`, sem credenciais (refeitas a cada requisição). */
export function cursorFromNextUrl(next: string): PageCursor {
  const out: PageCursor = {};
  try {
    for (const [key, value] of new URL(next).searchParams) {
      if (!SENSITIVE_QUERY.has(key)) out[key] = value;
    }
  } catch {
    // URL inválida: sem continuação
  }
  return out;
}

export class MetaClient {
  private readonly http: HttpDeps;
  readonly version: string;

  constructor(private readonly options: MetaClientOptions) {
    this.http = options.http ?? defaultHttpDeps;
    this.version = options.version;
  }

  private buildUrl(path: string, params: GraphParams): string {
    const url = new URL(`${graphBaseUrl(this.options.version)}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    if (this.options.tokenIn === "query") url.searchParams.set("access_token", this.options.accessToken);
    if (this.options.appSecret) url.searchParams.set("appsecret_proof", appSecretProof(this.options.accessToken, this.options.appSecret));
    return url.toString();
  }

  /** Garante que o token nunca apareça em mensagens, mesmo que a Meta o ecoe. */
  private scrub(error: unknown): unknown {
    if (!(error instanceof IntegrationError)) return error;
    const token = this.options.accessToken;
    if (!token || !error.message.includes(token)) return error;
    const message = error.message.split(token).join("[REDACTED]");
    const meta = error instanceof MetaApiError ? error : undefined;
    return new MetaApiError(message, error.kind, error.status, typeof error.providerCode === "number" ? error.providerCode : undefined,
      error.retryAfterMs, meta?.subcode, meta?.fbtraceId);
  }

  /** GET na Graph API. `path` é relativo à versão (ex.: "me/adaccounts"). */
  async get<T>(path: string, params: GraphParams = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = {};
    if (this.options.tokenIn !== "query") headers.Authorization = `Bearer ${this.options.accessToken}`;
    const maxAttempts = this.options.maxAttempts ?? 4;
    const maxInlineWait = this.options.maxInlineWaitMs ?? 60_000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await requestJson<T>(url, { headers, maxAttempts: 1, classifyError: classifyMetaError }, this.http);
      } catch (error) {
        const err = this.scrub(error);
        if (!(err instanceof IntegrationError)) throw err;
        const retriable = err.kind === "transient" || err.kind === "rate_limit";
        if (!retriable || attempt >= maxAttempts) throw err;
        // Limite longo: devolve à fila (o job é reagendado com retryAfterMs).
        if (err.retryAfterMs !== undefined && err.retryAfterMs > maxInlineWait) throw err;
        const backoff = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await this.http.sleep(backoff);
      }
    }
  }

  /** Busca UMA página de uma aresta (edge). Use `next` para continuar e salvar checkpoint. */
  async getPage<T>(path: string, params: GraphParams = {}, cursor: PageCursor | null = null): Promise<GraphPage<T>> {
    const response = await this.get<GraphListResponse<T>>(path, { ...params, ...(cursor ?? {}) });
    const data = Array.isArray(response?.data) ? response.data : [];
    const paging = response?.paging;
    let next: PageCursor | null = null;
    if (paging?.next && data.length > 0) {
      next = paging.cursors?.after ? { after: paging.cursors.after } : cursorFromNextUrl(paging.next);
      if (Object.keys(next).length === 0) next = null;
    }
    return { data, next };
  }

  /** Itera página a página (para quem não precisa de checkpoint). */
  async *pages<T>(path: string, params: GraphParams = {}, start: PageCursor | null = null, maxPages = 1000): AsyncGenerator<GraphPage<T>> {
    let cursor = start;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.getPage<T>(path, params, cursor);
      yield page;
      if (!page.next) return;
      cursor = page.next;
    }
  }

  /** Coleta todas as páginas (uso em listas pequenas, como a descoberta). */
  async getAll<T>(path: string, params: GraphParams = {}, maxPages = 100): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages<T>(path, params, null, maxPages)) out.push(...page.data);
    return out;
  }
}
