"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CopyField } from "@/components/admin/copy-field";
import type { AdminActionState } from "@/components/admin/action-button";
import { Checkbox, Field, FormMessage, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

const ROLE_OPTIONS = {
  agency: [{ value: "agency_manager", label: "Agência — gestão" }, { value: "agency_viewer", label: "Agência — consulta" }],
  ministry: [{ value: "leader", label: "Liderança do ministério" }, { value: "operational", label: "Responsável operacional" }],
} as const;

export function InviteForm({ action, ministries }: {
  action: (prev: AdminActionState | null, form: FormData) => Promise<AdminActionState>;
  ministries: Array<{ id: string; name: string }>;
}) {
  const [state, formAction] = useActionState(action, null);
  const [role, setRole] = useState<"superadmin" | "agency" | "ministry">("ministry");
  const [ministryId, setMinistryId] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  const err = state?.ok ? {} : (state?.errors ?? {});

  useEffect(() => {
    if (state?.ok) {
      ref.current?.reset();
      setRole("ministry");
      setMinistryId("");
    }
  }, [state]);

  return (
    <div className="space-y-4">
      {state?.ok && state.link ? <CopyField value={state.link} label={state.linkLabel ?? "Link de convite"} hint={state.linkHint} /> : null}
      <form ref={ref} action={formAction} className="space-y-3">
        <Field label="Nome" htmlFor="inv-name" error={err.name} required>
          <Input id="inv-name" name="name" required minLength={2} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="E-mail" htmlFor="inv-email" error={err.email} required>
          <Input id="inv-email" name="email" type="email" required maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Tipo de usuário" htmlFor="inv-role" error={err.globalRole} required>
          <Select id="inv-role" name="globalRole" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="ministry">Ministério (liderança/operacional)</option>
            <option value="agency">Equipe da agência</option>
            <option value="superadmin">Superadministrador</option>
          </Select>
        </Field>
        {role === "agency" ? (
          <Field label="Acesso global da agência" htmlFor="inv-access" error={err.agencyGlobalAccess}>
            <Select id="inv-access" name="agencyGlobalAccess" defaultValue="none">
              <option value="none">Somente ministérios atribuídos</option>
              <option value="read">Visão global (consulta)</option>
              <option value="manage">Visão global (gestão)</option>
            </Select>
          </Field>
        ) : null}
        {role !== "superadmin" ? (
          <>
            <Field label="Ministério" htmlFor="inv-ministry" error={err.ministryId} required={role === "ministry"}
              hint={role === "agency" ? "Opcional para a agência." : undefined}>
              <Select id="inv-ministry" name="ministryId" value={ministryId} onChange={(e) => setMinistryId(e.target.value)} required={role === "ministry"}>
                <option value="">{role === "agency" ? "Nenhum (definir depois)" : "Selecione…"}</option>
                {ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            {ministryId ? (
              <>
                <Field label="Papel no ministério" htmlFor="inv-mrole" error={err.ministryRole} required>
                  <Select id="inv-mrole" name="ministryRole" key={role} defaultValue={ROLE_OPTIONS[role][0].value}>
                    {ROLE_OPTIONS[role].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </Field>
                {role === "ministry" ? <Checkbox name="canViewInvestment" label="Pode ver investimentos" description="Valores investidos, CPC, CPM e custo por resultado." /> : null}
              </>
            ) : null}
          </>
        ) : <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">Superadministradores têm acesso total, inclusive a integrações e usuários.</p>}
        {!state?.ok ? <FormMessage state={state} /> : null}
        <SubmitButton pendingLabel="Gerando convite…">Gerar convite</SubmitButton>
        <p className="text-xs text-subtle">Não há envio de e-mail: o link é exibido uma única vez para você repassar com segurança.</p>
      </form>
    </div>
  );
}
