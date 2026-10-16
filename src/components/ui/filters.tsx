"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { PERIOD_PRESETS } from "@/lib/period";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { Sheet } from "./dialog";
import { Input, Select } from "./form";

export interface FilterDef {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
}

/**
 * Barra de filtros sincronizada com a URL (compartilhável e validada no
 * servidor). No mobile, os filtros abrem em uma gaveta.
 */
export function FilterBar({ filters = [], period = true, search }: { filters?: FilterDef[]; period?: boolean; search?: { name: string; placeholder: string } }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const preset = params.get("periodo") ?? "30d";

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("pagina");
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const activeCount = filters.filter((f) => params.get(f.name)).length + (params.get("periodo") ? 1 : 0);

  const controls = (stacked: boolean) => (
    <div className={cn("flex gap-2", stacked ? "flex-col" : "flex-wrap items-end")}>
      {search ? (
        <label className={cn("flex flex-col gap-1", stacked ? "" : "min-w-56")}>
          <span className="text-xs font-medium text-subtle">Buscar</span>
          <Input type="search" defaultValue={params.get(search.name) ?? ""} placeholder={search.placeholder}
            onKeyDown={(e) => { if (e.key === "Enter") update({ [search.name]: (e.target as HTMLInputElement).value.trim() || null }); }}
            onBlur={(e) => { if ((params.get(search.name) ?? "") !== e.target.value.trim()) update({ [search.name]: e.target.value.trim() || null }); }} />
        </label>
      ) : null}
      {period ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">Período</span>
          <Select value={preset} onChange={(e) => update({ periodo: e.target.value, ...(e.target.value !== "custom" ? { inicio: null, fim: null } : {}) })} className={stacked ? "" : "w-48"}>
            {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </label>
      ) : null}
      {period && preset === "custom" ? (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Início</span>
            <Input type="date" defaultValue={params.get("inicio") ?? ""} onChange={(e) => update({ inicio: e.target.value || null })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Fim</span>
            <Input type="date" defaultValue={params.get("fim") ?? ""} onChange={(e) => update({ fim: e.target.value || null })} />
          </label>
        </div>
      ) : null}
      {filters.map((f) => (
        <label key={f.name} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-subtle">{f.label}</span>
          <Select value={params.get(f.name) ?? ""} onChange={(e) => update({ [f.name]: e.target.value || null })} className={stacked ? "" : "w-48"}>
            <option value="">{f.allLabel ?? "Todos"}</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
      ))}
      {activeCount > 0 ? (
        <Button variant="ghost" size="sm" className={stacked ? "" : "mb-1"} onClick={() => {
          const keep = new URLSearchParams();
          startTransition(() => router.push(`${pathname}?${keep.toString()}`, { scroll: false }));
        }}>
          <X /> Limpar filtros
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className={cn("mb-6 transition-opacity", pending && "opacity-70")} aria-busy={pending}>
      <div className="hidden md:block">{controls(false)}</div>
      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen} side="bottom" title="Filtros"
          trigger={
            <Button variant="secondary" className="w-full justify-between">
              <span className="flex items-center gap-2"><SlidersHorizontal /> Filtros</span>
              {activeCount ? <span className="rounded-full bg-brand px-2 text-xs text-brand-contrast">{activeCount}</span> : null}
            </Button>
          }>
          {controls(true)}
          <Button className="mt-4 w-full" onClick={() => setOpen(false)}>Ver resultados</Button>
        </Sheet>
      </div>
    </div>
  );
}
