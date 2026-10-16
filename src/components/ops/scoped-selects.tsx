"use client";

import { useState } from "react";
import { Field, Select } from "@/components/ui/form";
import { cn } from "@/lib/cn";

interface Option { id: string; name: string }
interface Scoped extends Option { ministry_id: string }

/**
 * Seleção de ministério com campanha/evento/demanda filtrados pelo
 * ministério escolhido (o servidor e o banco revalidam o escopo).
 */
export function ScopedSelects({ idPrefix, ministries, campaigns, events, tasks, defaults = {}, lockMinistry, errors = {}, className, ministryLabel = "Ministério", allowEmptyMinistry, compact }: {
  idPrefix: string; ministries: Option[]; campaigns?: Scoped[]; events?: Scoped[]; tasks?: Scoped[];
  defaults?: { ministryId?: string | null; campaignId?: string | null; eventId?: string | null; taskId?: string | null };
  lockMinistry?: boolean; errors?: Record<string, string[] | undefined>; className?: string; ministryLabel?: string; allowEmptyMinistry?: boolean; compact?: boolean;
}) {
  const [ministryId, setMinistryId] = useState(defaults.ministryId ?? "");
  const [campaignId, setCampaignId] = useState(defaults.campaignId ?? "");
  const [eventId, setEventId] = useState(defaults.eventId ?? "");
  const [taskId, setTaskId] = useState(defaults.taskId ?? "");
  const scoped = <T extends Scoped>(list: T[] | undefined) => (list ?? []).filter((x) => x.ministry_id === ministryId);
  const onMinistry = (v: string) => {
    setMinistryId(v);
    setCampaignId("");
    setEventId("");
    setTaskId("");
  };
  const grid = cn("grid gap-3", compact ? "" : "md:grid-cols-2", className);
  return (
    <div className={grid}>
      <Field label={ministryLabel} htmlFor={`${idPrefix}-ministry`} error={errors.ministryId} required={!allowEmptyMinistry}>
        <Select id={`${idPrefix}-ministry`} name={lockMinistry ? undefined : "ministryId"} value={ministryId} disabled={lockMinistry}
          required={!allowEmptyMinistry} onChange={(e) => onMinistry(e.target.value)}>
          <option value="" disabled={!allowEmptyMinistry}>{allowEmptyMinistry ? "Sem ministério (manter na fila)" : "Selecione…"}</option>
          {ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        {lockMinistry ? <input type="hidden" name="ministryId" value={ministryId} /> : null}
      </Field>
      {campaigns ? (
        <Field label="Campanha" htmlFor={`${idPrefix}-campaign`} error={errors.campaignId} hint={ministryId ? undefined : "Escolha o ministério primeiro."}>
          <Select id={`${idPrefix}-campaign`} name="campaignId" value={campaignId} disabled={!ministryId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Nenhuma</option>
            {scoped(campaigns).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {events ? (
        <Field label="Evento" htmlFor={`${idPrefix}-event`} error={errors.eventId}>
          <Select id={`${idPrefix}-event`} name="eventId" value={eventId} disabled={!ministryId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Nenhum</option>
            {scoped(events).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {tasks ? (
        <Field label="Demanda relacionada" htmlFor={`${idPrefix}-task`} error={errors.taskId}>
          <Select id={`${idPrefix}-task`} name="taskId" value={taskId} disabled={!ministryId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Nenhuma</option>
            {scoped(tasks).map((c) => <option key={c.id} value={c.id}>{c.name.length > 80 ? `${c.name.slice(0, 79)}…` : c.name}</option>)}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}
