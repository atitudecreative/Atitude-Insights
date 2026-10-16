"use client";

import { useId, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Table2, BarChart3 } from "lucide-react";
import { formatDayMonth, formatMetric } from "@/lib/format";

/** Ordem fixa das cores categóricas — a cor segue a série, nunca a posição. */
export const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

export interface Series {
  key: string;
  label: string;
  /** Índice fixo da cor (0..5). */
  color?: number;
}

type Row = Record<string, string | number | null>;

const axisTick = { fill: "var(--chart-axis)", fontSize: 11 };

function formatX(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDayMonth(value) : value;
}

function TooltipBox({ active, payload, label, unit, currency }: {
  active?: boolean; payload?: Array<{ name?: string; value?: number | null; color?: string; dataKey?: string }>; label?: string; unit: string; currency?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      {label ? <p className="mb-1 font-medium text-foreground">{formatX(String(label))}</p> : null}
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={p.dataKey ?? p.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted"><span className="size-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
            <span className="tabular font-medium text-foreground">{p.value == null ? "sem dado" : formatMetric(p.value, unit, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Alternância gráfico/tabela: garante leitura sem depender de cor. */
function ChartFrame({ title, rows, series, xKey, unit, currency, height, children }: {
  title: string; rows: Row[]; series: Series[]; xKey: string; unit: string; currency?: string; height: number; children: React.ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const id = useId();
  return (
    <figure aria-labelledby={id} className="relative">
      <figcaption id={id} className="sr-only">{title}</figcaption>
      <div className="absolute -top-1 right-0 z-10">
        <button type="button" onClick={() => setView(view === "chart" ? "table" : "chart")}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-subtle hover:bg-surface-muted hover:text-foreground"
          aria-label={view === "chart" ? `Ver ${title} como tabela` : `Ver ${title} como gráfico`}>
          {view === "chart" ? <Table2 className="size-3.5" /> : <BarChart3 className="size-3.5" />}
          {view === "chart" ? "Tabela" : "Gráfico"}
        </button>
      </div>
      {view === "chart" ? (
        <div style={{ height }} className="pt-6">{children}</div>
      ) : (
        <div className="max-h-[22rem] overflow-auto pt-7">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-border text-left text-subtle">
              <th className="py-1.5 pr-3 font-medium" scope="col">{xKey === "date" ? "Data" : "Item"}</th>
              {series.map((s) => <th key={s.key} scope="col" className="py-1.5 pr-3 text-right font-medium">{s.label}</th>)}
            </tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} className="border-b border-border/60">
                <td className="py-1.5 pr-3">{formatX(String(r[xKey]))}</td>
                {series.map((s) => <td key={s.key} className="tabular py-1.5 pr-3 text-right">{r[s.key] == null ? "—" : formatMetric(Number(r[s.key]), unit, currency)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

export function TrendChart({ title, rows, series, unit = "count", currency, height = 260, xKey = "date" }: {
  title: string; rows: Row[]; series: Series[]; unit?: string; currency?: string; height?: number; xKey?: string;
}) {
  const gid = useId().replace(/:/g, "");
  return (
    <ChartFrame title={title} rows={rows} series={series} xKey={xKey} unit={unit} currency={currency} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES_COLORS[s.color ?? i]} stopOpacity={series.length > 1 ? 0.08 : 0.18} />
                <stop offset="100%" stopColor={SERIES_COLORS[s.color ?? i]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey={xKey} tickFormatter={formatX} tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v: number) => formatMetric(v, unit, currency, { compact: true })} />
          <Tooltip content={<TooltipBox unit={unit} currency={currency} />} cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }} />
          {series.length > 1 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "var(--foreground-muted)" }} /> : null}
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES_COLORS[s.color ?? i]} strokeWidth={2}
              fill={`url(#${gid}-${s.key})`} connectNulls={false} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function BarsChart({ title, rows, series, unit = "count", currency, height = 260, xKey = "label", horizontal, stacked }: {
  title: string; rows: Row[]; series: Series[]; unit?: string; currency?: string; height?: number; xKey?: string; horizontal?: boolean; stacked?: boolean;
}) {
  return (
    <ChartFrame title={title} rows={rows} series={series} xKey={xKey} unit={unit} currency={currency} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--chart-grid)" />
          {horizontal ? (
            <>
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatMetric(v, unit, currency, { compact: true })} />
              <YAxis type="category" dataKey={xKey} tick={axisTick} tickLine={false} axisLine={false} width={120}
                tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} tickFormatter={formatX} tick={axisTick} tickLine={false} axisLine={false} minTickGap={12} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatMetric(v, unit, currency, { compact: true })} />
            </>
          )}
          <Tooltip content={<TooltipBox unit={unit} currency={currency} />} cursor={{ fill: "var(--surface-muted)" }} />
          {series.length > 1 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "var(--foreground-muted)" }} /> : null}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES_COLORS[s.color ?? i]} stackId={stacked ? "s" : undefined}
              radius={stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} stroke="var(--surface)" strokeWidth={stacked ? 2 : 0} maxBarSize={36} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function DonutChart({ title, items, unit = "count", height = 220 }: {
  title: string; items: Array<{ label: string; value: number; color?: number }>; unit?: string; height?: number;
}) {
  const total = items.reduce((a, b) => a + b.value, 0);
  const rows = items.map((i) => ({ label: i.label, value: i.value }));
  return (
    <ChartFrame title={title} rows={rows} series={[{ key: "value", label: "Quantidade" }]} xKey="label" unit={unit} height={height}>
      <div className="flex h-full flex-col items-center gap-4 sm:flex-row">
        <div className="relative h-full min-h-40 w-full max-w-[220px] flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={items} dataKey="value" nameKey="label" innerRadius="64%" outerRadius="92%" stroke="var(--surface)" strokeWidth={2} paddingAngle={0}>
                {items.map((it, i) => <Cell key={it.label} fill={SERIES_COLORS[it.color ?? i]} />)}
              </Pie>
              <Tooltip content={<TooltipBox unit={unit} />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="tabular text-xl font-semibold">{formatMetric(total, unit)}</span>
            <span className="text-xs text-subtle">total</span>
          </div>
        </div>
        <ul className="w-full flex-1 space-y-1.5 text-sm">
          {items.map((it, i) => (
            <li key={it.label} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-muted"><span className="size-2.5 rounded-full" style={{ background: SERIES_COLORS[it.color ?? i] }} />{it.label}</span>
              <span className="tabular font-medium">{formatMetric(it.value, unit)} <span className="text-xs text-subtle">({total ? Math.round((it.value / total) * 100) : 0}%)</span></span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}
