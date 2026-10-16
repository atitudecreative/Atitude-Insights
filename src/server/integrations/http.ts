import { redactSecrets } from "@/server/security/crypto";

export type IntegrationErrorKind = "auth" | "permission" | "rate_limit" | "transient" | "not_found" | "invalid_request" | "permanent";

/** Erro normalizado de integração. A mensagem nunca contém tokens. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly kind: IntegrationErrorKind,
    public readonly status?: number,
    public readonly providerCode?: string | number,
    public readonly retryAfterMs?: number,
  ) {
    super(redactSecrets(message));
    this.name = "IntegrationError";
  }
}

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** Tentativas totais em falhas temporárias (429/5xx/rede). */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Converte a resposta de erro do provedor em IntegrationError. */
  classifyError: (status: number, body: unknown, headers: Headers) => IntegrationError;
}

function retryDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 120_000);
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Requisição JSON com repetição para falhas temporárias e respeito ao
 * Retry-After. Erros de autenticação/permissão não são repetidos.
 */
export async function requestJson<T>(url: string, options: RequestOptions, deps: HttpDeps = defaultHttpDeps): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: IntegrationError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: options.method ?? "GET",
        headers: { Accept: "application/json", ...options.headers },
        body: options.body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      lastError = new IntegrationError(`Falha de rede: ${(error as Error).message}`, "transient");
      if (attempt < maxAttempts) {
        await deps.sleep(retryDelay(attempt));
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = options.classifyError(response.status, body, response.headers);
    lastError = error;
    const retriable = error.kind === "rate_limit" || error.kind === "transient";
    if (!retriable || attempt === maxAttempts) throw error;
    await deps.sleep(retryDelay(attempt, error.retryAfterMs));
  }
  throw lastError ?? new IntegrationError("Falha desconhecida", "permanent");
}
