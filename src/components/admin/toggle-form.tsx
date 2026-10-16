"use client";

import { useActionState, useRef } from "react";
import type { AdminActionState } from "./action-button";

/** Interruptor (checkbox) que envia o formulário ao mudar. */
export function ToggleForm({ action, name = "enabled", checked, label, hidden, disabled }: {
  action: (prev: AdminActionState | null, form: FormData) => Promise<AdminActionState>;
  name?: string; checked: boolean; label: string; hidden?: Record<string, string>; disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={formAction} className="inline-flex flex-col gap-1">
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" name={name} value="on" defaultChecked={checked} disabled={disabled || pending}
          className="size-4 accent-[var(--brand)]" onChange={() => ref.current?.requestSubmit()} />
        <span className={pending ? "text-subtle" : undefined}>{label}</span>
      </label>
      {state && !state.ok && state.message ? <span className="text-xs text-danger" role="alert">{state.message}</span> : null}
    </form>
  );
}
