"use client";

import { useActionState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ButtonProps } from "@/components/ui/button";
import type { ActionState } from "@/server/services/context";
import { CopyField } from "./copy-field";

/** Retorno de ações administrativas; `link` é exibido uma única vez. */
export interface AdminActionState extends ActionState {
  link?: string;
  linkLabel?: string;
  linkHint?: string;
}

/**
 * Botão ligado a uma Server Action (com campos ocultos e confirmação
 * opcional), exibindo o retorno logo abaixo.
 */
export function ActionButton({ action, label, pendingLabel, confirm, variant = "secondary", size = "sm", hidden, className, children }: {
  action: (prev: AdminActionState | null, form: FormData) => Promise<AdminActionState>;
  label: ReactNode; pendingLabel?: string; confirm?: string; variant?: ButtonProps["variant"]; size?: ButtonProps["size"];
  hidden?: Record<string, string>; className?: string; children?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={cn("space-y-2", className)}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      {children}
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel}>{label}</SubmitButton>
      {state?.link ? <CopyField value={state.link} label={state.linkLabel ?? "Link gerado"} hint={state.linkHint} /> : null}
      {state?.message && !state.link ? <FormMessage state={state} /> : null}
    </form>
  );
}
