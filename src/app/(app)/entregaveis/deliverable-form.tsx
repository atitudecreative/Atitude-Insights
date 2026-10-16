"use client";

import { useActionState } from "react";
import { ScopedSelects } from "@/components/ops/scoped-selects";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { DELIVERABLE_STATUS, DELIVERABLE_TYPE } from "@/lib/labels";
import type { ActionState } from "@/server/services/context";

interface Option { id: string; name: string }
type Scoped = Option & { ministry_id: string };
export interface DeliverableDefaults {
  ministryId?: string | null; campaignId?: string | null; eventId?: string | null; taskId?: string | null; title?: string; description?: string | null;
  type?: string; status?: string; url?: string | null; dueDate?: string | null;
}

export function DeliverableForm({ action, options, defaults, isEdit }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  options: { ministries: Option[]; campaigns: Scoped[]; events: Scoped[]; tasks: Scoped[] };
  defaults: DeliverableDefaults; isEdit?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const err = state?.errors ?? {};
  return (
    <form action={formAction} className="space-y-5">
      <Card>
        <CardHeader title="Vínculos" description="Campanha, evento e demanda devem ser do mesmo ministério" />
        <CardContent>
          <ScopedSelects idPrefix="dl" ministries={options.ministries} campaigns={options.campaigns} events={options.events} tasks={options.tasks}
            lockMinistry={isEdit} errors={err} defaults={defaults} ministryLabel="Ministério responsável" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Entregável" />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Título" htmlFor="title" error={err.title} required className="md:col-span-2">
            <Input id="title" name="title" defaultValue={defaults.title} required maxLength={200} />
          </Field>
          <Field label="Tipo" htmlFor="type" error={err.type} required>
            <Select id="type" name="type" defaultValue={defaults.type ?? ""} required>
              <option value="" disabled>Selecione…</option>
              {Object.entries(DELIVERABLE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Status" htmlFor="status" error={err.status}>
            <Select id="status" name="status" defaultValue={defaults.status ?? "in_production"}>
              {Object.entries(DELIVERABLE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <Field label="Link do arquivo ou publicação" htmlFor="url" error={err.url} hint="Opcional · http(s)">
            <Input id="url" name="url" type="url" inputMode="url" placeholder="https://" defaultValue={defaults.url ?? ""} />
          </Field>
          <Field label="Prazo" htmlFor="dueDate" error={err.dueDate}>
            <Input id="dueDate" name="dueDate" type="date" defaultValue={defaults.dueDate ?? ""} />
          </Field>
          <Field label="Descrição" htmlFor="description" error={err.description} className="md:col-span-2">
            <Textarea id="description" name="description" defaultValue={defaults.description ?? ""} />
          </Field>
        </CardContent>
      </Card>
      <FormMessage state={state} />
      <div className="flex justify-end gap-2">
        <SubmitButton size="lg" pendingLabel="Salvando…">{isEdit ? "Salvar alterações" : "Registrar entregável"}</SubmitButton>
      </div>
    </form>
  );
}
