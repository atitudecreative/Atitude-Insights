export type RawSearch = Record<string, string | string[] | undefined>;

export function param(sp: RawSearch, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length <= 200 ? s : undefined;
}

export function pageParam(sp: RawSearch): number {
  const n = Number(param(sp, "pagina"));
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 1;
}

export function flatParams(sp: RawSearch): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(sp).map((k) => [k, param(sp, k)]));
}
