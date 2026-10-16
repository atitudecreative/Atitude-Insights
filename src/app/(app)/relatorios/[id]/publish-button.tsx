"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionState } from "@/server/services/context";

export function PublishButton({ action, label }: { action: (prev: ActionState | null) => Promise<ActionState>; label: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-2" onSubmit={(e) => { if (!window.confirm("Publicar congela os dados atuais em uma nova versão visível ao ministério. Continuar?")) e.preventDefault(); }}>
      <SubmitButton pendingLabel="Publicando…" className="w-full">{label}</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
