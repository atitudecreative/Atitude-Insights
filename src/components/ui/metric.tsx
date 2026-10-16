import { ArrowDownRight, ArrowUpRight, Clock, Lock, Minus, PlugZap, RefreshCw, CircleSlash } from "lucide-react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatMetric, formatPercent, formatRelative } from "@/lib/format";
import type { Change, MetricValue } from "@/lib/metrics";

const STATE_META: Record<Exclude<MetricValue["state"], "value">, { label: string; icon: LucideIcon; className: string; help: string }> = {
  unavailable: { label: "Indisponível", icon: CircleSlash, className: "text-subtle", help: "A fonte conectada não fornece este indicador para o período ou configuração." },
  disconnected: { label: "Sem integração", icon: PlugZap, className: "text-warning", help: "Nenhuma conta conectada fornece este dado." },
  processing: { label: "Processando", icon: RefreshCw, className: "text-info", help: "Aguardando a sincronização dos dados." },
  restricted: { label: "Restrito", icon: Lock, className: "text-subtle", help: "Seu perfil não tem permissão para visualizar este dado." },
};

/** Exibe um valor de métrica diferenciando zero real de ausência de dados. */
export function MetricDisplay({ value, unit = "count", currency = "BRL", size = "lg", compact = true }: {
  value: MetricValue; unit?: string; currency?: string; size?: "sm" | "md" | "lg"; compact?: boolean;
}) {
  const sizeClass = size === "lg" ? "text-[28px] leading-8" : size === "md" ? "text-xl" : "text-base";
  if (value.state !== "value") {
    const meta = STATE_META[value.state];
    const Icon = meta.icon;
    return (
      <span className={cn("inline-flex items-center gap-1.5 font-medium", size === "lg" ? "text-base" : "text-sm", meta.className)} title={value.note ?? meta.help}>
        <Icon className="size-4" aria-hidden />
        {meta.label}
        <span className="sr-only">: {value.note ?? meta.help}</span>
      </span>
    );
  }
  return (
    <span className={cn("tabular font-semibold tracking-tight text-foreground", sizeClass)}>
      {formatMetric(value.value, unit, currency, { compact })}
    </span>
  );
}

export function ChangeIndicator({ change, invert, label = "vs. período anterior" }: { change: Change | null | undefined; invert?: boolean; label?: string }) {
  if (!change || change.direction === "none") {
    return <span className="text-xs text-subtle">Sem base de comparação</span>;
  }
  if (change.percent == null) {
    return <span className="text-xs text-subtle">Período anterior sem registro</span>;
  }
  const good = change.direction === "flat" ? null : (change.direction === "up") !== Boolean(invert);
  const Icon = change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={cn("inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium tabular",
        good == null ? "bg-surface-muted text-muted" : good ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
        <Icon className="size-3.5" aria-hidden />
        {formatPercent(Math.abs(change.percent))}
      </span>
      <span className="text-subtle">{label}</span>
    </span>
  );
}

export function KpiCard({ label, value, unit, currency, change, invertChange, href, icon: Icon, hint, footer, className }: {
  label: string; value: MetricValue; unit?: string; currency?: string; change?: Change | null; invertChange?: boolean;
  href?: string; icon?: LucideIcon; hint?: string; footer?: ReactNode; className?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-subtle" aria-hidden /> : null}
      </div>
      <div className="mt-2 min-h-8">
        <MetricDisplay value={value} unit={unit} currency={currency} />
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
        {change !== undefined && value.state === "value" ? <ChangeIndicator change={change} invert={invertChange} /> : null}
        {value.stale ? (
          <span className="inline-flex items-center gap-1 text-xs text-warning" title="Dados desatualizados">
            <Clock className="size-3" aria-hidden /> Atualizado {formatRelative(value.updatedAt)}
          </span>
        ) : null}
        {hint ? <span className="text-xs text-subtle">{hint}</span> : null}
      </div>
      {footer}
    </>
  );
  const base = cn("group relative flex flex-col rounded-card border border-border bg-surface p-4 shadow-card transition-colors", className);
  if (href) {
    return (
      <Link href={href} className={cn(base, "hover:border-border-strong hover:bg-surface-muted/40 focus-visible:outline-2 focus-visible:outline-ring")}>
        {body}
        <span className="sr-only">Ver detalhes de {label}</span>
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}
