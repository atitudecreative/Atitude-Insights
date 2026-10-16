import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { isIsoDate } from "@/lib/period";
import { asUser, isUuid } from "./context";
import type { DataMode } from "./mode";

/**
 * Exportações CSV. Toda leitura passa pelo papel restrito (RLS): a planilha
 * contém exatamente o que o usuário já pode ver no portal.
 */

export type CsvCell = string | number | boolean | Date | null | undefined;

/** Início de célula que planilhas interpretam como fórmula (CSV/formula injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

const dateTimeFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Converte um valor em célula CSV segura (separador `;`, padrão do Excel em pt-BR). */
export function csvCell(value: CsvCell): string {
  if (value == null) return "";
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = String(value).replace(".", ",");
  } else if (typeof value === "boolean") {
    text = value ? "sim" : "não";
  } else if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? "" : dateTimeFmt.format(value);
  } else {
    text = value;
    // Neutraliza fórmulas: o apóstrofo força o conteúdo a ser lido como texto.
    if (FORMULA_START.test(text)) text = `'${text}`;
  }
  if (/[;"\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Monta o CSV completo (com BOM UTF-8 para acentuação correta no Excel). */
export function buildCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(csvCell).join(";"), ...rows.map((r) => r.map(csvCell).join(";"))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Registra a exportação no histórico de auditoria (contexto do usuário). */
export async function logExport(actor: Actor, entity: string, filters: Record<string, unknown>, rows: number): Promise<void> {
  await asUser(actor, (trx) => audit(trx, {
    entityType: entity, action: "exported", summary: `Exportação CSV (${entity}): ${rows} linha(s)`,
    changes: { filters, rows }, visibility: "admin",
  }));
}

export const METRICS_EXPORT_LIMIT = 50_000;

/**
 * Métricas diárias de mídia paga (Meta Ads, nível de campanha). Métricas
 * monetárias só retornam para ministérios em que o usuário pode ver
 * investimento (política RLS de metric_observations).
 */
export async function metricsExportRows(actor: Actor, f: { mode: DataMode; start: string; end: string; ministryId?: string | null }) {
  if (!isIsoDate(f.start) || !isIsoDate(f.end)) return [];
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.metric_observations as o").innerJoin("app.ministries as m", "m.id", "o.ministry_id")
      .leftJoin("app.external_campaigns as c", (j) => j.onRef("c.id", "=", "o.entity_id").on("o.entity_type", "=", "meta_campaign"))
      .select(["m.name as ministry_name", "o.source", "o.metric_key", "o.entity_type", "o.entity_id", "c.name as entity_name", "o.period_start",
        "o.value", "o.currency", "o.is_monetary", "o.collected_at"])
      .where("m.is_demo", "=", f.mode === "demo")
      .where("o.source", "=", "meta_ads").where("o.granularity", "=", "day")
      .where("o.period_start", ">=", f.start).where("o.period_start", "<=", f.end);
    if (isUuid(f.ministryId)) q = q.where("o.ministry_id", "=", f.ministryId);
    return q.orderBy("o.period_start").orderBy("m.name").orderBy("o.entity_id").orderBy("o.metric_key").limit(METRICS_EXPORT_LIMIT).execute();
  });
}
