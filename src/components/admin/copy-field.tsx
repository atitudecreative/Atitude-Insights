"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Exibe um valor sensível de uso único (ex.: link de convite) com botão de copiar. */
export function CopyField({ value, label = "Link", hint }: { value: string; label?: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rounded-lg border border-success/30 bg-success-soft p-3" role="status">
      <p className="text-sm font-medium text-success">{label}</p>
      <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground" />
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? "Copiado" : "Copiar"}
        </Button>
      </div>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
