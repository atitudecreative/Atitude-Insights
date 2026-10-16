const nf = new Intl.NumberFormat("pt-BR");
const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

export function formatNumber(value: number | null | undefined, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (opts.compact && Math.abs(value) >= 10_000) return compact.format(value);
  if (opts.decimals !== undefined) {
    return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: opts.decimals, maximumFractionDigits: opts.decimals }).format(value);
  }
  return nf.format(Math.round(value * 100) / 100);
}

export function formatCurrency(value: number | null | undefined, currency = "BRL", opts: { compact?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency", currency, notation: opts.compact && Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)}%`;
}

export function formatMetric(value: number | null | undefined, unit: string, currency = "BRL", opts: { compact?: boolean } = {}): string {
  switch (unit) {
    case "currency": return formatCurrency(value, currency, opts);
    case "percent": return formatPercent(value);
    case "ratio": return formatNumber(value, { decimals: 2 });
    default: return formatNumber(value, opts);
  }
}

const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
const longDateFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/** Data ISO (YYYY-MM-DD) ou Date. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}/${m}/${y}`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFmt.format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFmt.format(date);
}

export function formatEventDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : longDateFmt.format(date);
}

export function formatDayMonth(iso: string): string {
  return dayMonthFmt.format(new Date(`${iso}T00:00:00Z`)).replace(".", "");
}

export function formatRelative(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return "nunca";
  const diff = now.getTime() - new Date(value).getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  const sign = diff >= 0 ? -1 : 1;
  if (abs < 60_000) return "agora";
  if (abs < 3600_000) return rtf.format(sign * Math.round(abs / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(sign * Math.round(abs / 3600_000), "hour");
  if (abs < 30 * 86400_000) return rtf.format(sign * Math.round(abs / 86400_000), "day");
  return formatDate(value instanceof Date ? value : new Date(value));
}

export function slugify(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}
