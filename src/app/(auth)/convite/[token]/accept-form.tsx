"use client";

import { useActionState } from "react";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { acceptInviteAction } from "../../actions";

export function AcceptForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(acceptInviteAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field label="E-mail" htmlFor="email"><Input id="email" value={email} readOnly disabled autoComplete="username" /></Field>
      <Field label="Nova senha" htmlFor="password" hint="Mínimo de 10 caracteres, com letras e números.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
      </Field>
      <Field label="Confirme a senha" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <FormMessage state={state} />
      <SubmitButton className="w-full" size="lg" pendingLabel="Salvando…">Definir senha e entrar</SubmitButton>
    </form>
  );
}
