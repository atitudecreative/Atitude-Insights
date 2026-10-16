"use client";

import { useActionState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormMessage, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { CAMPAIGN_STATUS } from "@/lib/labels";
import type { ActionState } from "@/server/services/context";

interface Option { id: string; name: string }
export interface CampaignDefaults {
  ministryId?: string; name?: string; description?: string | null; objective?: string | null; targetAudience?: string | null;
  startDate?: string | null; endDate?: string | null; status?: string; channelIds?: string[]; responsibleIds?: string[]; eventIds?: string[];
}

export function CampaignForm({ action, options, defaults, isEdit }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  options: { ministries: Option[]; channels: Option[]; users: Option[]; events: Array<Option & { ministry_id: string }> };
  defaults: CampaignDefaults; isEdit?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const err = state?.errors ?? {};
  return (
    <form action={formAction} className="space-y-5">
      <Card>
        <CardHeader title="Identificação" />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Ministério responsável" htmlFor="ministryId" error={err.ministryId} required>
            <Select id="ministryId" name="ministryId" defaultValue={defaults.ministryId ?? ""} disabled={isEdit} required>
              <option value="" disabled>Selecione…</option>
              {options.ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            {isEdit ? <input type="hidden" name="ministryId" value={defaults.ministryId} /> : null}
          </Field>
          <Field label="Status" htmlFor="status" error={err.status}>
            <Select id="status" name="status" defaultValue={defaults.status ?? "planning"}>
              {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <Field label="Nome da campanha" htmlFor="name" error={err.name} required className="md:col-span-2">
            <Input id="name" name="name" defaultValue={defaults.name} required maxLength={200} />
          </Field>
          <Field label="Descrição" htmlFor="description" error={err.description} className="md:col-span-2">
            <Textarea id="description" name="description" defaultValue={defaults.description ?? ""} />
          </Field>
          <Field label="Início" htmlFor="startDate" error={err.startDate}><Input id="startDate" name="startDate" type="date" defaultValue={defaults.startDate ?? ""} /></Field>
          <Field label="Encerramento" htmlFor="endDate" error={err.endDate}><Input id="endDate" name="endDate" type="date" defaultValue={defaults.endDate ?? ""} /></Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Estratégia" />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Objetivo" htmlFor="objective" error={err.objective}><Textarea id="objective" name="objective" defaultValue={defaults.objective ?? ""} /></Field>
          <Field label="Público-alvo" htmlFor="targetAudience" error={err.targetAudience}><Textarea id="targetAudience" name="targetAudience" defaultValue={defaults.targetAudience ?? ""} /></Field>
          {!isEdit ? (
            <Field label="Investimento planejado (R$)" htmlFor="plannedInvestment" hint="Opcional. Pode ser detalhado depois na aba Investimento." error={err.plannedInvestment}>
              <Input id="plannedInvestment" name="plannedInvestment" type="number" min={0} step="0.01" inputMode="decimal" />
            </Field>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Canais, responsáveis e eventos" />
        <CardContent className="grid gap-6 md:grid-cols-3">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Canais</legend>
            <div className="space-y-1">{options.channels.map((c) => <Checkbox key={c.id} name="channelIds" value={c.id} label={c.name} defaultChecked={defaults.channelIds?.includes(c.id)} />)}</div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Responsáveis da agência</legend>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {options.users.length ? options.users.map((u) => <Checkbox key={u.id} name="responsibleIds" value={u.id} label={u.name} defaultChecked={defaults.responsibleIds?.includes(u.id)} />)
                : <p className="text-sm text-subtle">Nenhum usuário da agência disponível.</p>}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Eventos relacionados</legend>
            <p className="mb-2 text-xs text-subtle">Apenas eventos do mesmo ministério serão aceitos.</p>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {options.events.filter((e) => !defaults.ministryId || e.ministry_id === defaults.ministryId).map((e) => (
                <Checkbox key={e.id} name="eventIds" value={e.id} label={e.name} defaultChecked={defaults.eventIds?.includes(e.id)} />
              ))}
              {!options.events.length ? <p className="text-sm text-subtle">Nenhum evento cadastrado.</p> : null}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <FormMessage state={state} />
      <div className="flex justify-end gap-2">
        <SubmitButton size="lg" pendingLabel="Salvando…">{isEdit ? "Salvar alterações" : "Criar campanha"}</SubmitButton>
      </div>
    </form>
  );
}
