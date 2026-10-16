"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/form";

interface Opt { id: string; name: string; ministry_id?: string }

/** Campos de escopo/período compartilhados pelos formulários de relatório. */
export function ReportParamsFields({ ministries, campaigns, events, defaults, allowAgency }: {
  ministries: Opt[]; campaigns: Opt[]; events: Opt[]; allowAgency: boolean;
  defaults: { scopeType?: string; ministryId?: string; campaignId?: string; eventId?: string; start: string; end: string; channel?: string };
}) {
  const [scope, setScope] = useState(defaults.scopeType ?? (allowAgency ? "agency" : "ministry"));
  const [ministry, setMinistry] = useState(defaults.ministryId ?? ministries[0]?.id ?? "");
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="Tipo de relatório" htmlFor="scopeType">
        <Select id="scopeType" name="scopeType" value={scope} onChange={(e) => setScope(e.target.value)}>
          {allowAgency ? <option value="agency">Consolidado da agência</option> : null}
          <option value="ministry">Por ministério</option>
          <option value="campaign">Por campanha</option>
          <option value="event">Por evento</option>
        </Select>
      </Field>
      {scope === "ministry" ? (
        <Field label="Ministério" htmlFor="ministryId">
          <Select id="ministryId" name="ministryId" value={ministry} onChange={(e) => setMinistry(e.target.value)} required>
            {ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {scope === "campaign" ? (
        <Field label="Campanha" htmlFor="campaignId">
          <Select id="campaignId" name="campaignId" defaultValue={defaults.campaignId ?? ""} required>
            <option value="" disabled>Selecione…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {scope === "event" ? (
        <Field label="Evento" htmlFor="eventId">
          <Select id="eventId" name="eventId" defaultValue={defaults.eventId ?? ""} required>
            <option value="" disabled>Selecione…</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label="Canal" htmlFor="channel">
        <Select id="channel" name="channel" defaultValue={defaults.channel ?? ""}>
          <option value="">Todos os canais</option>
          <option value="meta_ads">Meta Ads (pago)</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </Select>
      </Field>
      <Field label="Início" htmlFor="start"><Input id="start" name="start" type="date" defaultValue={defaults.start} required /></Field>
      <Field label="Fim" htmlFor="end"><Input id="end" name="end" type="date" defaultValue={defaults.end} required /></Field>
    </div>
  );
}
