/**
 * Períodos de análise. Datas são strings ISO (YYYY-MM-DD) sem fuso para
 * evitar deslocamentos; "hoje" é calculado em America/Sao_Paulo.
 */
export type PeriodPreset = "7d" | "30d" | "90d" | "month" | "last_month" | "quarter" | "year" | "custom";

export interface Period {
  start: string;
  end: string;
  preset: PeriodPreset;
  label: string;
}

export const PERIOD_PRESETS: Array<{ value: PeriodPreset; label: string }> = [
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "90d", label: "Últimos 90 dias" },
  { value: "month", label: "Este mês" },
  { value: "last_month", label: "Mês anterior" },
  { value: "quarter", label: "Este trimestre" },
  { value: "year", label: "Este ano" },
  { value: "custom", label: "Personalizado" },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function todayIso(timeZone = "America/Sao_Paulo", now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA => YYYY-MM-DD
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000);
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function endOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function formatIsoShort(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Interpreta ?periodo=&inicio=&fim= (valores inválidos caem no padrão). */
export function parsePeriod(params: { periodo?: string | null; inicio?: string | null; fim?: string | null }, today = todayIso()): Period {
  const preset = (PERIOD_PRESETS.find((p) => p.value === params.periodo)?.value ?? "30d") as PeriodPreset;
  let start: string;
  let end = today;
  switch (preset) {
    case "7d": start = addDays(today, -6); break;
    case "90d": start = addDays(today, -89); break;
    case "month": start = startOfMonth(today); break;
    case "last_month": {
      const prev = addDays(startOfMonth(today), -1);
      start = startOfMonth(prev);
      end = endOfMonth(prev);
      break;
    }
    case "quarter": {
      const [y, m] = today.split("-").map(Number) as [number, number];
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      start = `${y}-${String(qStart).padStart(2, "0")}-01`;
      break;
    }
    case "year": start = `${today.slice(0, 4)}-01-01`; break;
    case "custom": {
      if (isIsoDate(params.inicio) && isIsoDate(params.fim) && params.inicio <= params.fim && diffDays(params.inicio, params.fim) <= 3 * 366) {
        start = params.inicio;
        end = params.fim;
      } else {
        start = addDays(today, -29);
      }
      break;
    }
    default: start = addDays(today, -29);
  }
  const label = preset === "custom" || preset === "last_month" || preset === "month" || preset === "quarter" || preset === "year"
    ? `${formatIsoShort(start)} – ${formatIsoShort(end)}`
    : `${PERIOD_PRESETS.find((p) => p.value === preset)!.label} (${formatIsoShort(start)} – ${formatIsoShort(end)})`;
  return { start, end, preset, label };
}

/** Período imediatamente anterior, de mesma duração. */
export function previousPeriod(period: Pick<Period, "start" | "end">): { start: string; end: string } {
  const length = diffDays(period.start, period.end) + 1;
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

export function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export type Bucket = "day" | "week" | "month";

export function bucketFor(period: Pick<Period, "start" | "end">): Bucket {
  const days = diffDays(period.start, period.end) + 1;
  if (days <= 45) return "day";
  if (days <= 200) return "week";
  return "month";
}

/** Chave do balde (início da semana ISO — segunda — ou do mês). */
export function bucketKey(iso: string, bucket: Bucket): string {
  if (bucket === "day") return iso;
  if (bucket === "month") return startOfMonth(iso);
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

export function enumerateBuckets(period: Pick<Period, "start" | "end">, bucket: Bucket = bucketFor(period)): string[] {
  const keys = new Set<string>();
  for (const d of enumerateDays(period.start, period.end)) keys.add(bucketKey(d, bucket));
  return [...keys];
}
