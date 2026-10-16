"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { AdminActionState } from "@/components/admin/action-button";
import { Checkbox, Field, FormMessage, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

interface Option { id: string; name: string }
interface Scoped extends Option { ministry_id: string }
export interface ProjectStructure {
  projectAssetId: string;
  sections: Array<{ gid: string; name: string }>;
  customFields: Array<{ gid: string; name: string; options: Array<{ gid: string; name: string }> }>;
}

const ASANA_TYPES = [
  { value: "asana_project", label: "Projeto inteiro" },
  { value: "asana_section", label: "Seção do projeto" },
  { value: "asana_tag", label: "Tag" },
  { value: "asana_custom_field", label: "Campo personalizado" },
];

export function RuleForm({ action, provider, assets, ministries, campaigns, events, structure }: {
  action: (prev: AdminActionState | null, form: FormData) => Promise<AdminActionState>;
  provider: "asana" | "meta";
  assets: Option[];
  ministries: Option[];
  campaigns: Scoped[];
  events: Scoped[];
  structure: ProjectStructure | null;
}) {
  const [state, formAction] = useActionState(action, null);
  const [ruleType, setRuleType] = useState(provider === "asana" ? (structure ? "asana_section" : "asana_project") : "meta_campaign_name_prefix");
  const [assetId, setAssetId] = useState(structure?.projectAssetId ?? "");
  const [ministryId, setMinistryId] = useState("");
  const [fieldGid, setFieldGid] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  const err = state?.ok ? {} : (state?.errors ?? {});
  const live = structure && structure.projectAssetId === assetId ? structure : null;
  const field = live?.customFields.find((f) => f.gid === fieldGid);

  useEffect(() => {
    if (state?.ok) { ref.current?.reset(); setMinistryId(""); setFieldGid(""); }
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <input type="hidden" name="provider" value={provider} />
      <div className="grid gap-3 sm:grid-cols-2">
        {provider === "asana" ? (
          <Field label="Tipo de regra" htmlFor="rule-type" error={err.ruleType}>
            <Select id="rule-type" name="ruleType" value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
              {ASANA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
        ) : <input type="hidden" name="ruleType" value="meta_campaign_name_prefix" />}
        <Field label={provider === "asana" ? "Projeto" : "Conta de anúncios"} htmlFor="rule-asset" error={err.externalAssetId}
          required={ruleType === "asana_project"} hint={ruleType === "asana_project" ? undefined : "Opcional: restringe a regra a este ativo."}>
          <Select id="rule-asset" name="externalAssetId" value={assetId} onChange={(e) => setAssetId(e.target.value)} required={ruleType === "asana_project"}>
            <option value="">{ruleType === "asana_project" ? "Selecione…" : "Qualquer"}</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>

        {ruleType === "asana_section" ? (
          <Field label="Seção" htmlFor="rule-value" error={err.matchValue} required className="sm:col-span-2"
            hint={live ? undefined : "Carregue o projeto acima para escolher a seção, ou informe o GID da seção."}>
            {live?.sections.length ? (
              <Select id="rule-value" name="matchValue" required defaultValue="">
                <option value="" disabled>Selecione…</option>
                {live.sections.map((s) => <option key={s.gid} value={s.gid}>{s.name}</option>)}
              </Select>
            ) : <Input id="rule-value" name="matchValue" required placeholder="GID da seção" inputMode="numeric" />}
          </Field>
        ) : null}
        {ruleType === "asana_tag" ? (
          <Field label="GID da tag" htmlFor="rule-value" error={err.matchValue} required className="sm:col-span-2" hint="Disponível na URL da tag no Asana.">
            <Input id="rule-value" name="matchValue" required inputMode="numeric" />
          </Field>
        ) : null}
        {ruleType === "asana_custom_field" ? (
          <>
            <Field label="Campo personalizado" htmlFor="rule-field" error={err.matchField} required
              hint={live ? undefined : "Carregue o projeto para escolher, ou informe o GID do campo."}>
              {live?.customFields.length ? (
                <Select id="rule-field" name="matchField" required value={fieldGid} onChange={(e) => setFieldGid(e.target.value)}>
                  <option value="" disabled>Selecione…</option>
                  {live.customFields.map((f) => <option key={f.gid} value={f.gid}>{f.name}</option>)}
                </Select>
              ) : <Input id="rule-field" name="matchField" required placeholder="GID do campo" />}
            </Field>
            <Field label="Valor" htmlFor="rule-value" error={err.matchValue} required hint={field?.options.length ? undefined : "Opção (GID) ou texto exato exibido no campo."}>
              {field?.options.length ? (
                <Select id="rule-value" name="matchValue" required defaultValue="" key={field.gid}>
                  <option value="" disabled>Selecione…</option>
                  {field.options.map((o) => <option key={o.gid} value={o.gid}>{o.name}</option>)}
                </Select>
              ) : <Input id="rule-value" name="matchValue" required />}
            </Field>
          </>
        ) : null}
        {ruleType === "meta_campaign_name_prefix" ? (
          <Field label="Prefixo do nome da campanha" htmlFor="rule-value" error={err.matchValue} required className="sm:col-span-2"
            hint="Ex.: “KIDS |” — sem diferenciar maiúsculas de minúsculas.">
            <Input id="rule-value" name="matchValue" required maxLength={300} />
          </Field>
        ) : null}

        <Field label="Ministério de destino" htmlFor="rule-ministry" error={err.ministryId} required>
          <Select id="rule-ministry" name="ministryId" required value={ministryId} onChange={(e) => setMinistryId(e.target.value)}>
            <option value="" disabled>Selecione…</option>
            {ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Prioridade" htmlFor="rule-priority" error={err.priority} hint="Menor número = maior prioridade.">
          <Input id="rule-priority" name="priority" type="number" min={1} max={1000} defaultValue={100} />
        </Field>
        <Field label="Campanha (opcional)" htmlFor="rule-campaign" error={err.campaignId}>
          <Select id="rule-campaign" name="campaignId" defaultValue="" key={`c-${ministryId}`} disabled={!ministryId}>
            <option value="">Nenhuma</option>
            {campaigns.filter((c) => c.ministry_id === ministryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Evento (opcional)" htmlFor="rule-event" error={err.eventId}>
          <Select id="rule-event" name="eventId" defaultValue="" key={`e-${ministryId}`} disabled={!ministryId}>
            <option value="">Nenhum</option>
            {events.filter((e) => e.ministry_id === ministryId).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        </Field>
      </div>
      <Checkbox name="active" defaultChecked label="Regra ativa" />
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Salvando…">Adicionar regra</SubmitButton>
    </form>
  );
}
