const localFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const isoDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/** Valor para <input type="datetime-local"> no horário de Brasília. */
export function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : localFmt.format(d).replace(" ", "T");
}

/** Data ISO (YYYY-MM-DD) de um instante, no horário de Brasília. */
export function toIsoDay(value: Date | string): string {
  return isoDayFmt.format(new Date(value));
}
