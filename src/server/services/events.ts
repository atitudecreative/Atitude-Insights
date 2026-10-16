import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import type { Json } from "@/server/db/schema.generated";
import { asUser, isUuid, ministryAccess, ServiceError, zodErrors } from "./context";
import type { DataMode } from "./mode";

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const optionalDate = z.union([z.literal(""), z.iso.date("Data inválida")]).optional().transform((v) => v || null);

export const EVENT_STATUSES = ["planned", "confirmed", "finished", "cancelled"] as const;

const linkSchema = z.object({ label: z.string().trim().min(1).max(100), url: z.url().refine((u) => /^https?:\/\//.test(u), "URL inválida") });

export const eventInput = z.object({
  ministryId: z.uuid("Selecione o ministério"),
  name: z.string().trim().min(2, "Informe o nome").max(200),
  description: optionalText(5000),
  startsAt: z.string().min(1, "Informe data e hora").refine((v) => !Number.isNaN(Date.parse(v)), "Data inválida"),
  endsAt: z.string().optional().transform((v) => v || null).refine((v) => v === null || !Number.isNaN(Date.parse(v)), "Data inválida"),
  location: optionalText(300),
  communicationObjective: optionalText(2000),
  promotionStart: optionalDate,
  promotionEnd: optionalDate,
  status: z.enum(EVENT_STATUSES).default("planned"),
  links: z.array(linkSchema).max(20).default([]),
  responsibleIds: z.array(z.uuid()).max(30).default([]),
  campaignIds: z.array(z.uuid()).max(30).default([]),
})
  .refine((v) => !v.endsAt || Date.parse(v.endsAt) >= Date.parse(v.startsAt), { message: "O término deve ser após o início", path: ["endsAt"] })
  .refine((v) => !v.promotionStart || !v.promotionEnd || v.promotionEnd >= v.promotionStart, { message: "Período de divulgação inválido", path: ["promotionEnd"] });

/** Converte "YYYY-MM-DDTHH:mm" (input datetime-local, horário de Brasília) em Date. */
export function parseLocalDateTime(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return new Date(`${value}:00-03:00`);
  return new Date(value);
}

export async function listEvents(actor: Actor, f: { mode: DataMode; ministryId?: string; status?: string; when?: "upcoming" | "past" | "all"; q?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  const pageSize = f.pageSize ?? 20;
  const page = Math.max(1, f.page ?? 1);
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.events as e").innerJoin("app.ministries as m", "m.id", "e.ministry_id")
      .where("m.is_demo", "=", f.mode === "demo").where("e.archived_at", "is", null);
    if (isUuid(f.ministryId)) q = q.where("e.ministry_id", "=", f.ministryId);
    if (f.status && (EVENT_STATUSES as readonly string[]).includes(f.status)) q = q.where("e.status", "=", f.status);
    const now = new Date();
    if (f.when === "upcoming") q = q.where((eb) => eb.or([eb("e.starts_at", ">=", now), eb("e.ends_at", ">=", now)]));
    if (f.when === "past") q = q.where("e.starts_at", "<", now);
    if (f.from) q = q.where("e.starts_at", ">=", new Date(`${f.from}T00:00:00-03:00`));
    if (f.to) q = q.where("e.starts_at", "<=", new Date(`${f.to}T23:59:59-03:00`));
    if (f.q) q = q.where("e.name", "ilike", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q.select((eb) => [
      "e.id", "e.name", "e.starts_at", "e.ends_at", "e.location", "e.status", "e.promotion_start", "e.promotion_end", "e.ministry_id",
      "m.name as ministry_name", "m.slug as ministry_slug", "m.color as ministry_color",
      eb.selectFrom("app.campaign_events as ce").select((e) => e.fn.countAll<number>().as("n")).whereRef("ce.event_id", "=", "e.id").as("campaigns"),
      eb.selectFrom("app.deliverables as d").select((e) => e.fn.countAll<number>().as("n")).whereRef("d.event_id", "=", "e.id").as("deliverables"),
    ]).orderBy("e.starts_at", f.when === "past" ? "desc" : "asc").limit(pageSize).offset((page - 1) * pageSize).execute();
    return { total: Number(total.n), page, pageSize, rows: rows.map((r) => ({ ...r, campaigns: Number(r.campaigns ?? 0), deliverables: Number(r.deliverables ?? 0) })) };
  });
}

export async function getEvent(actor: Actor, id: string) {
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const event = await trx.selectFrom("app.events as e").innerJoin("app.ministries as m", "m.id", "e.ministry_id")
      .select(["e.id", "e.ministry_id", "e.name", "e.description", "e.starts_at", "e.ends_at", "e.location", "e.communication_objective",
        "e.promotion_start", "e.promotion_end", "e.links", "e.status", "e.results_summary", "e.observations", "e.results_consolidated_at",
        "e.created_at", "e.updated_at", "m.name as ministry_name", "m.slug as ministry_slug", "m.is_demo"])
      .where("e.id", "=", id).executeTakeFirst();
    if (!event) return null;
    const access = await ministryAccess(trx, event.ministry_id);
    const [campaigns, responsibles, tasks, deliverables, results, history] = await Promise.all([
      trx.selectFrom("app.campaign_events as ce").innerJoin("app.campaigns as c", "c.id", "ce.campaign_id")
        .select(["c.id", "c.name", "c.status", "c.start_date", "c.end_date"]).where("ce.event_id", "=", id).execute(),
      trx.selectFrom("app.event_responsibles as r").innerJoin("app.users as u", "u.id", "r.user_id").select(["u.id", "u.name"]).where("r.event_id", "=", id).execute(),
      trx.selectFrom("app.tasks").select(["id", "name", "completed", "completed_at", "due_on", "assignee_name", "source", "permalink_url", "removed_in_source_at"])
        .where((eb) => eb.or([eb("event_id", "=", id), eb("campaign_id", "in", eb.selectFrom("app.campaign_events").select("campaign_id").where("event_id", "=", id))]))
        .orderBy("completed").orderBy("due_on").execute(),
      trx.selectFrom("app.deliverables").select(["id", "title", "type", "status", "url", "due_date", "delivered_at"])
        .where((eb) => eb.or([eb("event_id", "=", id), eb("campaign_id", "in", eb.selectFrom("app.campaign_events").select("campaign_id").where("event_id", "=", id))]))
        .orderBy("created_at", "desc").execute(),
      trx.selectFrom("app.event_results").select(["id", "label", "value", "unit", "source", "notes", "created_at"]).where("event_id", "=", id).orderBy("created_at").execute(),
      trx.selectFrom("app.activity_logs as l").leftJoin("app.users as u", "u.id", "l.actor_user_id")
        .select(["l.id", "l.action", "l.summary", "l.created_at", "u.name as actor_name"])
        .where("l.entity_type", "=", "event").where("l.entity_id", "=", id).orderBy("l.created_at", "desc").limit(30).execute(),
    ]);
    return { event: { ...event, links: (event.links as Array<{ label: string; url: string }>) ?? [] }, access, campaigns, responsibles, tasks, deliverables, results, history };
  });
}

function parseEvent(raw: unknown) {
  const parsed = eventInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos destacados.", "invalid", zodErrors(parsed.error.issues));
  return parsed.data;
}

export async function createEvent(actor: Actor, raw: unknown): Promise<string> {
  const input = parseEvent(raw);
  return asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.events").values({
      ministry_id: input.ministryId, name: input.name, description: input.description, starts_at: parseLocalDateTime(input.startsAt),
      ends_at: input.endsAt ? parseLocalDateTime(input.endsAt) : null, location: input.location, communication_objective: input.communicationObjective,
      promotion_start: input.promotionStart, promotion_end: input.promotionEnd, status: input.status,
      links: JSON.stringify(input.links) as unknown as Json, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    if (input.responsibleIds.length) await trx.insertInto("app.event_responsibles").values(input.responsibleIds.map((user_id) => ({ event_id: row.id, user_id }))).execute();
    if (input.campaignIds.length) await trx.insertInto("app.campaign_events").values(input.campaignIds.map((campaign_id) => ({ campaign_id, event_id: row.id }))).execute();
    await audit(trx, { ministryId: input.ministryId, entityType: "event", entityId: row.id, action: "created", summary: `Evento "${input.name}" criado` });
    return row.id;
  });
}

export async function updateEvent(actor: Actor, id: string, raw: unknown): Promise<void> {
  const input = parseEvent(raw);
  await asUser(actor, async (trx) => {
    const before = await trx.selectFrom("app.events").select(["ministry_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!before) throw new ServiceError("Evento não encontrado.", "not_found");
    if (before.ministry_id !== input.ministryId) throw new ServiceError("Não é possível mover o evento para outro ministério.");
    const r = await trx.updateTable("app.events").set({
      name: input.name, description: input.description, starts_at: parseLocalDateTime(input.startsAt),
      ends_at: input.endsAt ? parseLocalDateTime(input.endsAt) : null, location: input.location, communication_objective: input.communicationObjective,
      promotion_start: input.promotionStart, promotion_end: input.promotionEnd, status: input.status, links: JSON.stringify(input.links) as unknown as Json,
    }).where("id", "=", id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Sem permissão para editar este evento.", "forbidden");
    await trx.deleteFrom("app.event_responsibles").where("event_id", "=", id).execute();
    if (input.responsibleIds.length) await trx.insertInto("app.event_responsibles").values(input.responsibleIds.map((user_id) => ({ event_id: id, user_id }))).execute();
    await trx.deleteFrom("app.campaign_events").where("event_id", "=", id).execute();
    if (input.campaignIds.length) await trx.insertInto("app.campaign_events").values(input.campaignIds.map((campaign_id) => ({ campaign_id, event_id: id }))).execute();
    await audit(trx, { ministryId: before.ministry_id, entityType: "event", entityId: id, action: "updated", summary: `Evento "${input.name}" atualizado`,
      changes: before.status !== input.status ? { status: { from: before.status, to: input.status } } : {} });
  });
}

export const eventResultInput = z.object({
  label: z.string().trim().min(2, "Descreva o resultado").max(200),
  value: z.union([z.literal(""), z.coerce.number().min(0)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  unit: z.enum(["count", "currency", "percent"]).default("count"),
  source: z.string().trim().min(2, "Informe a fonte (ex.: sistema de inscrições, contagem na porta)").max(300),
  notes: z.string().trim().max(2000).optional().transform((v) => v || null),
});

/** Resultados pós-evento: sempre com fonte declarada (não inferidos de métricas digitais). */
export async function addEventResult(actor: Actor, eventId: string, raw: unknown): Promise<void> {
  const parsed = eventResultInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  await asUser(actor, async (trx) => {
    const e = await trx.selectFrom("app.events").select("ministry_id").where("id", "=", eventId).executeTakeFirst();
    if (!e) throw new ServiceError("Evento não encontrado.", "not_found");
    await trx.insertInto("app.event_results").values({ ministry_id: e.ministry_id, event_id: eventId, ...parsed.data, recorded_by: actor.userId }).execute();
    await audit(trx, { ministryId: e.ministry_id, entityType: "event", entityId: eventId, action: "result_recorded", summary: `Resultado registrado: ${parsed.data.label}` });
  });
}

export async function deleteEventResult(actor: Actor, resultId: string): Promise<void> {
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.event_results").where("id", "=", resultId).returning(["ministry_id", "event_id"]).executeTakeFirst();
    if (!r) throw new ServiceError("Registro não encontrado ou sem permissão.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "event", entityId: r.event_id, action: "result_deleted", summary: "Resultado removido" });
  });
}

export async function updateEventConsolidation(actor: Actor, eventId: string, raw: { resultsSummary?: string; observations?: string; consolidate?: boolean }): Promise<void> {
  const resultsSummary = raw.resultsSummary?.trim().slice(0, 10000) || null;
  const observations = raw.observations?.trim().slice(0, 10000) || null;
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.events").set({
      results_summary: resultsSummary, observations, ...(raw.consolidate ? { results_consolidated_at: new Date(), status: "finished" } : {}),
    }).where("id", "=", eventId).returning("ministry_id").executeTakeFirst();
    if (!r) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: r.ministry_id, entityType: "event", entityId: eventId, action: raw.consolidate ? "results_consolidated" : "notes_updated",
      summary: raw.consolidate ? "Resultados consolidados" : "Observações atualizadas" });
  });
}

export type EventStage = "planning" | "production" | "promotion" | "event" | "post_event" | "consolidation";

/** Etapa de comunicação atual, derivada das datas cadastradas (não inventa progresso). */
export function eventStages(e: { created_at: Date; promotion_start: string | null; promotion_end: string | null; starts_at: Date; ends_at: Date | null; results_consolidated_at: Date | null; status: string }, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const start = new Date(e.starts_at);
  const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 4 * 3600_000);
  let current: EventStage;
  if (e.results_consolidated_at) current = "consolidation";
  else if (now > end) current = "post_event";
  else if (now >= start) current = "event";
  else if (e.promotion_start && today >= e.promotion_start) current = "promotion";
  else if (e.status === "confirmed") current = "production";
  else current = "planning";
  const order: EventStage[] = ["planning", "production", "promotion", "event", "post_event", "consolidation"];
  const idx = order.indexOf(current);
  return order.map((key, i) => ({ key, state: (i < idx ? "done" : i === idx ? "current" : "upcoming") as "done" | "current" | "upcoming" }));
}
