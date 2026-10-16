import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right";
  /** Oculta na lista mobile (o conteúdo continua acessível na página de detalhe). */
  hideOnMobile?: boolean;
  /** Título usado na lista mobile. */
  mobileLabel?: string;
}

/**
 * Tabela responsiva: tabela completa a partir de md; no mobile vira lista
 * de cartões (sem rolagem horizontal), mantendo todos os campos relevantes.
 */
export function DataTable<T>({ rows, columns, rowKey, caption, empty, mobileTitle }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; caption?: string; empty?: ReactNode;
  mobileTitle?: (row: T) => ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-subtle">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn("px-4 py-2.5 font-medium", c.align === "right" && "text-right", c.className)}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-4 py-3 align-middle", c.align === "right" && "text-right tabular", c.className)}>{c.cell(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="px-4 py-3">
            {mobileTitle ? <div className="mb-2 font-medium">{mobileTitle(row)}</div> : null}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              {columns.filter((c) => !c.hideOnMobile).map((c, i) => (
                <div key={c.key} className={cn("min-w-0", i === 0 && !mobileTitle && "col-span-2")}>
                  <dt className="text-xs text-subtle">{c.mobileLabel ?? c.header}</dt>
                  <dd className="mt-0.5 min-w-0 break-words">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
