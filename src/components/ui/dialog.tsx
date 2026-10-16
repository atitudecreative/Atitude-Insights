"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Dialog({ trigger, title, description, children, open, onOpenChange, wide }: {
  trigger?: ReactNode; title: string; description?: string; children: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void; wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content className={cn(
          "fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 shadow-pop focus:outline-none",
          "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[min(92vw,32rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
          wide && "sm:w-[min(94vw,46rem)]",
        )}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-lg font-semibold tracking-tight">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-subtle">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="-m-1 rounded-lg p-2 text-subtle hover:bg-surface-muted hover:text-foreground" aria-label="Fechar">
              <X className="size-4" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Sheet({ trigger, title, children, open, onOpenChange, side = "left" }: {
  trigger?: ReactNode; title: string; children: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void; side?: "left" | "right" | "bottom";
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <D.Content className={cn(
          "fixed z-50 flex flex-col overflow-y-auto border-border bg-surface shadow-pop focus:outline-none",
          side === "left" && "inset-y-0 left-0 w-[min(86vw,20rem)] border-r",
          side === "right" && "inset-y-0 right-0 w-[min(90vw,24rem)] border-l",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t",
        )}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            <D.Description className="sr-only">{title}</D.Description>
            <D.Close className="rounded-lg p-2 text-subtle hover:bg-surface-muted" aria-label="Fechar"><X className="size-4" /></D.Close>
          </div>
          <div className="flex-1 p-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const DialogClose = D.Close;
