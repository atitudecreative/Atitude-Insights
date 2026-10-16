/**
 * Conversão das respostas de insights da Meta em observações de métricas.
 * Regra central: métrica AUSENTE na resposta = indisponível → não gravamos
 * nada (nunca um zero inventado). Um "0" enviado pela Meta é gravado como 0.
 */

/**
 * Tipo de ação que representa o "resultado" de cada objetivo de campanha.
 * Mapa explícito e conservador (objetivos ODAX "OUTCOME_*" e legados):
 * - null = o objetivo não tem uma ação de resultado (ex.: reconhecimento,
 *   cujo resultado é o próprio alcance) → não gravamos `results`;
 * - objetivos fora do mapa (ex.: CONVERSIONS legado, cujo evento varia) →
 *   também não gravamos `results`.
 * Observação: no Gerenciador de Anúncios o "resultado" depende da meta de
 * otimização do conjunto; este mapa é uma aproximação documentada.
 */
export const RESULT_ACTION_BY_OBJECTIVE: Readonly<Record<string, string | null>> = {
  OUTCOME_TRAFFIC: "link_click",
  LINK_CLICKS: "link_click",
  OUTCOME_ENGAGEMENT: "post_engagement",
  POST_ENGAGEMENT: "post_engagement",
  PAGE_LIKES: "like",
  OUTCOME_LEADS: "lead",
  LEAD_GENERATION: "lead",
  OUTCOME_SALES: "offsite_conversion.fb_pixel_purchase",
  OUTCOME_APP_PROMOTION: "mobile_app_install",
  APP_INSTALLS: "mobile_app_install",
  VIDEO_VIEWS: "video_view",
  MESSAGES: "onsite_conversion.messaging_conversation_started_7d",
  OUTCOME_AWARENESS: null,
  BRAND_AWARENESS: null,
  REACH: null,
};

export function resultActionType(objective: string | null | undefined): string | null {
  if (!objective) return null;
  return RESULT_ACTION_BY_OBJECTIVE[objective.toUpperCase()] ?? null;
}

/** Ações tratadas como conversão (uma observação por action_type). */
export const CONVERSION_ACTION_TYPES: ReadonlySet<string> = new Set([
  "lead",
  "complete_registration",
  "purchase",
  "submit_application",
  "contact",
  "schedule",
  "subscribe",
  "start_trial",
  "donate",
  "find_location",
]);
export const CONVERSION_ACTION_PREFIXES: readonly string[] = ["offsite_conversion.", "onsite_conversion."];
/** Ações com prefixo de conversão que, na prática, são engajamento. */
const CONVERSION_EXCLUDED: ReadonlySet<string> = new Set(["onsite_conversion.post_save", "onsite_conversion.post_net_save"]);

export function isConversionAction(actionType: string): boolean {
  if (CONVERSION_EXCLUDED.has(actionType)) return false;
  return CONVERSION_ACTION_TYPES.has(actionType) || CONVERSION_ACTION_PREFIXES.some((p) => actionType.startsWith(p));
}

/** Converte valores da Meta (geralmente strings) em número; ausente/inválido → undefined. */
export function toMetricNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface ActionStat {
  action_type?: string;
  value?: string | number;
}

export interface InsightRow {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  inline_link_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  actions?: ActionStat[];
  action_values?: ActionStat[];
  cost_per_action_type?: ActionStat[];
}

export interface MetricValue {
  metricKey: string;
  dimensionKey: string;
  value: number;
}

/** Campos escalares de insights → chave de métrica do portal. */
export const INSIGHT_SCALAR_FIELDS: ReadonlyArray<readonly [keyof InsightRow, string]> = [
  ["spend", "spend"],
  ["impressions", "impressions"],
  ["reach", "reach"],
  ["frequency", "frequency"],
  ["clicks", "clicks"],
  ["inline_link_clicks", "link_clicks"],
  ["ctr", "ctr"],
  ["cpc", "cpc"],
  ["cpm", "cpm"],
];

/** Métricas derivadas de `actions`/`action_values` (sujeitas a revisão de atribuição). */
export const ACTION_DERIVED_METRICS: readonly string[] = ["video_views", "conversions", "conversion_value", "results"];

function actionValue(list: ActionStat[] | undefined, type: string): number | undefined {
  if (!Array.isArray(list)) return undefined;
  const item = list.find((a) => a.action_type === type);
  return item ? toMetricNumber(item.value) : undefined;
}

/**
 * Extrai as métricas de uma linha de insights. `objective` é o objetivo da
 * campanha (para `results`). Campos ausentes não geram observação.
 */
export function insightRowToMetrics(row: InsightRow, objective: string | null | undefined): MetricValue[] {
  const out: MetricValue[] = [];
  for (const [field, metricKey] of INSIGHT_SCALAR_FIELDS) {
    const value = toMetricNumber(row[field]);
    if (value !== undefined) out.push({ metricKey, dimensionKey: "", value });
  }
  const videoViews = actionValue(row.actions, "video_view");
  if (videoViews !== undefined) out.push({ metricKey: "video_views", dimensionKey: "", value: videoViews });

  const seen = new Set<string>();
  for (const action of row.actions ?? []) {
    if (!action.action_type || !isConversionAction(action.action_type)) continue;
    const value = toMetricNumber(action.value);
    if (value === undefined || seen.has(action.action_type)) continue;
    seen.add(action.action_type);
    out.push({ metricKey: "conversions", dimensionKey: action.action_type, value });
  }
  const seenValues = new Set<string>();
  for (const action of row.action_values ?? []) {
    if (!action.action_type || !isConversionAction(action.action_type)) continue;
    const value = toMetricNumber(action.value);
    if (value === undefined || seenValues.has(action.action_type)) continue;
    seenValues.add(action.action_type);
    out.push({ metricKey: "conversion_value", dimensionKey: action.action_type, value });
  }

  const resultType = resultActionType(objective);
  if (resultType) {
    const value = actionValue(row.actions, resultType);
    if (value !== undefined) out.push({ metricKey: "results", dimensionKey: resultType, value });
  }
  return out;
}

/** Métricas de mídia do Instagram (nome na API → chave do portal). */
export const INSTAGRAM_MEDIA_METRICS: ReadonlyArray<readonly [string, string]> = [
  ["reach", "reach"],
  ["views", "views"],
  ["likes", "likes"],
  ["comments", "comments"],
  ["shares", "shares"],
  ["saved", "saves"],
  ["total_interactions", "total_interactions"],
];

/**
 * Métricas de publicação de Página do Facebook. Os nomes mudaram várias vezes
 * (ex.: post_impressions → post_media_view); todas são opcionais.
 */
export const FACEBOOK_POST_METRICS: ReadonlyArray<readonly [string, string]> = [
  ["post_impressions_unique", "reach"],
  ["post_media_view", "views"],
];

/** Valor numérico de um item de /insights (formatos `values[0].value` ou `total_value.value`). */
export function insightItemValue(item: { values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }): number | undefined {
  const fromValues = Array.isArray(item.values) && item.values.length > 0 ? item.values[item.values.length - 1]?.value : undefined;
  return toMetricNumber(fromValues ?? item.total_value?.value);
}
