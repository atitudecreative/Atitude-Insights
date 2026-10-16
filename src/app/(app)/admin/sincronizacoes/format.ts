export function jobDuration(started: Date | string | null, finished: Date | string | null): string {
  if (!started) return "—";
  const ms = (finished ? new Date(finished).getTime() : Date.now()) - new Date(started).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function statsSummary(stats: Record<string, number>, max = 4): string {
  const entries = Object.entries(stats).filter(([, v]) => typeof v === "number" && v > 0);
  if (!entries.length) return "—";
  return entries.slice(0, max).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ") + (entries.length > max ? " …" : "");
}
