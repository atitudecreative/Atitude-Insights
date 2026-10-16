/**
 * Cálculos de indicadores e semântica de estados de métricas.
 * Regra central: ausência de dado NUNCA vira zero.
 */

export type MetricState =
  | "value" // valor observado (inclui zero real)
  | "unavailable" // a fonte não fornece este indicador para a configuração conectada
  | "disconnected" // nenhuma integração conectada para esta fonte
  | "processing" // sincronização em andamento / aguardando primeira coleta
  | "restricted"; // usuário sem permissão para ver (ex.: investimento)

export interface MetricValue {
  state: MetricState;
  value: number | null;
  /** true quando os dados existem, mas a última atualização é antiga. */
  stale?: boolean;
  updatedAt?: string | null;
  note?: string;
}

export const metric = {
  value: (value: number, extra: Partial<MetricValue> = {}): MetricValue => ({ state: "value", value, ...extra }),
  unavailable: (note?: string): MetricValue => ({ state: "unavailable", value: null, note }),
  disconnected: (note?: string): MetricValue => ({ state: "disconnected", value: null, note }),
  processing: (note?: string): MetricValue => ({ state: "processing", value: null, note }),
  restricted: (): MetricValue => ({ state: "restricted", value: null }),
};

/** Divisão segura: null quando numerador/denominador ausentes ou denominador zero. */
export function safeDivide(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/** CTR = cliques / impressões × 100 */
export function ctr(clicks: number | null | undefined, impressions: number | null | undefined): number | null {
  const r = safeDivide(clicks, impressions);
  return r == null ? null : r * 100;
}

/** CPC = investimento / cliques */
export function cpc(spend: number | null | undefined, clicks: number | null | undefined): number | null {
  return safeDivide(spend, clicks);
}

/** CPM = investimento / impressões × 1.000 */
export function cpm(spend: number | null | undefined, impressions: number | null | undefined): number | null {
  const r = safeDivide(spend, impressions);
  return r == null ? null : r * 1000;
}

/** Custo por resultado = investimento / quantidade de resultados */
export function costPerResult(spend: number | null | undefined, results: number | null | undefined): number | null {
  return safeDivide(spend, results);
}

/** Soma ignorando ausentes; retorna null se TODOS forem ausentes. */
export function sumNullable(values: Array<number | null | undefined>): number | null {
  let total: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    total = (total ?? 0) + v;
  }
  return total;
}

/** Engajamento = curtidas + comentários + compartilhamentos + salvamentos disponíveis. */
export function engagement(parts: { likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null }): number | null {
  return sumNullable([parts.likes, parts.comments, parts.shares, parts.saves]);
}

export interface Change {
  /** Variação percentual; null quando não comparável. */
  percent: number | null;
  absolute: number | null;
  direction: "up" | "down" | "flat" | "none";
  reason?: "no_previous" | "previous_zero" | "no_current";
}

/** Comparação com o período anterior, sem inventar variação quando não há base. */
export function compare(current: number | null | undefined, previous: number | null | undefined): Change {
  if (current == null) return { percent: null, absolute: null, direction: "none", reason: "no_current" };
  if (previous == null) return { percent: null, absolute: null, direction: "none", reason: "no_previous" };
  const absolute = current - previous;
  const direction = absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";
  if (previous === 0) return { percent: null, absolute, direction, reason: "previous_zero" };
  return { percent: (absolute / Math.abs(previous)) * 100, absolute, direction };
}

/** Converte um número possivelmente ausente em MetricValue, preservando zero real. */
export function toMetric(value: number | null | undefined, ctx: { hasSource: boolean; syncing?: boolean; restricted?: boolean; updatedAt?: string | null; staleAfterHours?: number; now?: Date }): MetricValue {
  if (ctx.restricted) return metric.restricted();
  if (!ctx.hasSource) return metric.disconnected();
  if (value == null) return ctx.syncing ? metric.processing() : metric.unavailable();
  const stale = isStale(ctx.updatedAt, ctx.staleAfterHours ?? 48, ctx.now);
  return metric.value(value, { updatedAt: ctx.updatedAt ?? null, stale });
}

export function isStale(updatedAt: string | Date | null | undefined, staleAfterHours: number, now = new Date()): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t > staleAfterHours * 3600_000;
}

/** Progresso de meta (realizado / meta). */
export function goalProgress(actual: number | null | undefined, target: number | null | undefined): number | null {
  const r = safeDivide(actual, target);
  return r == null ? null : r * 100;
}
