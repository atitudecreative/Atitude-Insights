import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TimelineStep {
  key: string;
  title: string;
  description?: ReactNode;
  date?: string;
  state: "done" | "current" | "upcoming";
}

export function StageTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map((s) => (
        <li key={s.key} className={cn("relative rounded-lg border p-3",
          s.state === "current" ? "border-brand bg-brand-soft" : "border-border bg-surface")}>
          <div className="flex items-center gap-2">
            <span className={cn("flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
              s.state === "done" ? "bg-success text-white" : s.state === "current" ? "bg-brand text-brand-contrast" : "bg-surface-sunken text-subtle")}>
              {s.state === "done" ? <Check className="size-3" aria-hidden /> : null}
            </span>
            <span className="text-sm font-medium">{s.title}</span>
            <span className="sr-only">{s.state === "done" ? "(concluída)" : s.state === "current" ? "(etapa atual)" : "(próxima)"}</span>
          </div>
          {s.date ? <p className="mt-1.5 text-xs text-subtle">{s.date}</p> : null}
          {s.description ? <div className="mt-1 text-xs text-muted">{s.description}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export function ActivityFeed({ items }: { items: Array<{ id: string; title: ReactNode; meta: ReactNode }> }) {
  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {items.map((it) => (
        <li key={it.id} className="relative">
          <span aria-hidden className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand" />
          <p className="text-sm text-foreground">{it.title}</p>
          <p className="mt-0.5 text-xs text-subtle">{it.meta}</p>
        </li>
      ))}
    </ol>
  );
}
