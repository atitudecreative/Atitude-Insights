"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ActionState } from "@/server/services/context";
import { FormMessage } from "./form";
import { SubmitButton } from "./submit-button";

/**
 * Formulário genérico ligado a uma Server Action: exibe o retorno (sucesso
 * ou erro), destaca erros por campo e limpa os campos após sucesso.
 */
export function ActionForm({ action, children, submitLabel, pendingLabel, className, resetOnSuccess = true, submitVariant, inline }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  children: ReactNode; submitLabel: string; pendingLabel?: string; className?: string; resetOnSuccess?: boolean;
  submitVariant?: "primary" | "secondary" | "danger" | "outline"; inline?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={cn(inline ? "flex flex-wrap items-end gap-2" : "space-y-3", className)}>
      {children}
      {state?.errors && !state.ok ? (
        <ul className="text-xs text-danger" role="alert">
          {Object.entries(state.errors).map(([k, v]) => <li key={k}>{v[0]}</li>)}
        </ul>
      ) : null}
      <FormMessage state={state?.errors && !state.ok ? { ok: false, message: state.message } : state} />
      <SubmitButton variant={submitVariant} pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** Botão que dispara uma ação simples (ex.: remover), com confirmação. */
export function ConfirmButton({ action, label, confirm, className }: { action: () => Promise<void>; label: ReactNode; confirm: string; className?: string }) {
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(confirm)) e.preventDefault(); }}>
      <button type="submit" className={cn("rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft", className)}>{label}</button>
    </form>
  );
}
