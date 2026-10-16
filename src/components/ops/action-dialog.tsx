"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionState } from "@/server/services/context";

/** Diálogo com formulário ligado a uma Server Action; fecha ao concluir com sucesso. */
export function ActionDialog({ trigger, title, description, action, submitLabel, children, wide }: {
  trigger: ReactNode; title: string; description?: string; submitLabel: string; wide?: boolean;
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen} trigger={trigger} title={title} description={description} wide={wide}>
      {open ? <DialogForm action={action} submitLabel={submitLabel} onDone={() => setOpen(false)}>{children}</DialogForm> : null}
    </Dialog>
  );
}

function DialogForm({ action, submitLabel, onDone, children }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>; submitLabel: string; onDone: () => void; children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);
  return (
    <form action={formAction} className="space-y-4">
      {children}
      {state?.errors && !state.ok ? (
        <ul className="text-xs text-danger" role="alert">
          {Object.entries(state.errors).map(([k, v]) => <li key={k}>{v[0]}</li>)}
        </ul>
      ) : null}
      <FormMessage state={state?.ok ? null : state} />
      <div className="flex justify-end"><SubmitButton pendingLabel="Salvando…">{submitLabel}</SubmitButton></div>
    </form>
  );
}
