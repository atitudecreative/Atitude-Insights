import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export function Pagination({ page, pageSize, total, basePath, params }: {
  page: number; pageSize: number; total: number; basePath: string; params: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== "pagina") sp.set(k, v);
    sp.set("pagina", String(p));
    return `${basePath}?${sp.toString()}`;
  };
  const link = "inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-surface px-3 text-sm hover:bg-surface-muted";
  return (
    <nav aria-label="Paginação" className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <span className="text-subtle">Página {page} de {pages} · {total} itens</span>
      <div className="flex gap-2">
        {page > 1 ? <Link className={link} href={href(page - 1)} rel="prev"><ChevronLeft className="size-4" />Anterior</Link>
          : <span className={cn(link, "pointer-events-none opacity-40")} aria-disabled>Anterior</span>}
        {page < pages ? <Link className={link} href={href(page + 1)} rel="next">Próxima<ChevronRight className="size-4" /></Link>
          : <span className={cn(link, "pointer-events-none opacity-40")} aria-disabled>Próxima</span>}
      </div>
    </nav>
  );
}
