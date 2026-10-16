"use client";

import { useActionState, useState } from "react";
import { LinksEditor } from "@/components/ops/links-editor";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { EVENT_STATUS } from "@/lib/labels";
import type { ActionState } from "@/server/services/context";

interface Option { id: string; name: string }
export interface EventDefaults {
  ministryId?: string; name?: string; description?: string | null; startsAt?: string; endsAt?: string; location?: string | null;
  communicationObjective?: string | null; promotionStart?: string | null; promotionEnd?: string | null; status?: string;
  links?: Array<{ label: string; url: string }>; responsibleIds?: string[]; campaignIds?: string[];
}

export function EventForm({ action, options, defaults, isEdit }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  options: { ministries: Option[]; users: Option[]; campaigns: Array<Option & { ministry_id: string }> };
  defaults: EventDefaults; isEdit?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const [ministryId, setMinistryId] = useState(defaults.ministryId ?? "");
  const err = state?.errors ?? {};
  const campaigns = options.campaigns.filter((c) => c.ministry_id === ministryId);
  return (
    <form action={formAction} className="space-y-5">
      <Card>
        <CardHeader title="Identificação" />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Ministério responsável" htmlFor="ministryId" error={err.ministryId} required>
            <Select id="ministryId" name={isEdit ? undefined : "ministryId"} value={ministryId} disabled={isEdit} required onChange={(e) => setMinistryId(e.target.value)}>
              <option value="" disabled>Selecione…</option>
              {options.ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            {isEdit ? <input type="hidden" name="ministryId" value={ministryId} /> : null}
          </Field>
          <Field label="Status" htmlFor="status" error={err.status}>
            <Select id="status" name="status" defaultValue={defaults.status ?? "planned"}>
              {Object.entries(EVENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <Field label="Nome do evento" htmlFor="name" error={err.name} required className="md:col-span-2">
            <Input id="name" name="name" defaultValue={defaults.name} required maxLength={200} />
          </Field>
          <Field label="Descrição" htmlFor="description" error={err.description} className="md:col-span-2">
            <Textarea id="description" name="description" defaultValue={defaults.description ?? ""} />
          </Field>
          <Field label="Início" htmlFor="startsAt" error={err.startsAt} required hint="Horário de Brasília">
            <Input id="startsAt" name="startsAt" type="datetime-local" defaultValue={defaults.startsAt ?? ""} required />
          </Field>
          <Field label="Término" htmlFor="endsAt" error={err.endsAt} hint="Opcional · horário de Brasília">
            <Input id="endsAt" name="endsAt" type="datetime-local" defaultValue={defaults.endsAt ?? ""} />
          </Field>
          <Field label="Local" htmlFor="location" error={err.location} className="md:col-span-2">
            <Input id="location" name="location" defaultValue={defaults.location ?? ""} maxLength={300} placeholder="Ex.: Auditório principal" />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Comunicação" description="Objetivo e período de divulgação usados na linha do tempo e nos resultados" />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Objetivo de comunicação" htmlFor="communicationObjective" error={err.communicationObjective} className="md:col-span-2">
            <Textarea id="communicationObjective" name="communicationObjective" defaultValue={defaults.communicationObjective ?? ""} />
          </Field>
          <Field label="Início da divulgação" htmlFor="promotionStart" error={err.promotionStart}>
            <Input id="promotionStart" name="promotionStart" type="date" defaultValue={defaults.promotionStart ?? ""} />
          </Field>
          <Field label="Fim da divulgação" htmlFor="promotionEnd" error={err.promotionEnd}>
            <Input id="promotionEnd" name="promotionEnd" type="date" defaultValue={defaults.promotionEnd ?? ""} />
          </Field>
          <div className="md:col-span-2">
            <p className="mb-2 text-sm font-medium">Links</p>
            <p className="mb-2 text-xs text-subtle">Inscrições, landing page, pasta de materiais etc. Somente links http(s).</p>
            <LinksEditor name="links" defaultValue={defaults.links} error={err.links} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Responsáveis e campanhas" />
        <CardContent className="grid gap-6 md:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Responsáveis da agência</legend>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {options.users.length ? options.users.map((u) => <Checkbox key={u.id} name="responsibleIds" value={u.id} label={u.name} defaultChecked={defaults.responsibleIds?.includes(u.id)} />)
                : <p className="text-sm text-subtle">Nenhum usuário da agência disponível.</p>}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Campanhas relacionadas</legend>
            <p className="mb-2 text-xs text-subtle">Apenas campanhas do mesmo ministério.</p>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {campaigns.map((c) => <Checkbox key={c.id} name="campaignIds" value={c.id} label={c.name} defaultChecked={defaults.campaignIds?.includes(c.id)} />)}
              {!campaigns.length ? <p className="text-sm text-subtle">{ministryId ? "Nenhuma campanha neste ministério." : "Selecione o ministério."}</p> : null}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <FormMessage state={state} />
      <div className="flex justify-end gap-2">
        <SubmitButton size="lg" pendingLabel="Salvando…">{isEdit ? "Salvar alterações" : "Criar evento"}</SubmitButton>
      </div>
    </form>
  );
}
