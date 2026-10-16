"use client";

import { useActionState, type ReactNode } from "react";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionState } from "@/server/services/context";

/**
 * Formulário com mais de um botão de envio: o botão acionado vai no campo
 * `intent` (ex.: salvar × consolidar; aprovar × solicitar ajustes).
 */
export function IntentForm({ action, children, buttons, className }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>; children: ReactNode; className?: string;
  buttons: Array<{ intent: string; label: string; variant?: "primary" | "secondary" | "danger" | "outline"; confirm?: string }>;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className ?? "space-y-3"}>
      {children}
      <FormMessage state={state} />
      <div className="flex flex-wrap justify-end gap-2">
        {buttons.map((b) => (
          <SubmitButton key={b.intent} name="intent" value={b.intent} variant={b.variant}
            onClick={b.confirm ? (e) => { if (!window.confirm(b.confirm)) e.preventDefault(); } : undefined}>
            {b.label}
          </SubmitButton>
        ))}
      </div>
    </form>
  );
}
