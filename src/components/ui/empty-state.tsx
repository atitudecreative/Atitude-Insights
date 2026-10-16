import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({ icon: Icon, title, description, action, className, compact }: {
  icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-card border border-dashed border-border-strong bg-surface-muted/50 text-center", compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12", className)}>
      {Icon ? (
        <div className="flex size-11 items-center justify-center rounded-full bg-surface text-subtle shadow-card ring-1 ring-border">
          <Icon className="size-5" aria-hidden />
        </div>
      ) : null}
      <div className="max-w-md">
        <p className="font-medium text-foreground">{title}</p>
        {description ? <div className="mt-1 text-sm text-subtle">{description}</div> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
