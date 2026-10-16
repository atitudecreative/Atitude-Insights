import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { todayIso } from "@/lib/period";
import { asUser, isUuid, ServiceError, zodErrors } from "./context";
import type { DataMode } from "./mode";

export interface TaskFilters {
  mode: DataMode;
  ministryId?: string;
  campaignId?: string;
  eventId?: string;
  status?: "completed" | "open" | "overdue" | string;
  source?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listTasks(actor: Actor, f: TaskFilters) {
  const pageSize = f.pageSize ?? 25;
  const page = Math.max(1, f.page ?? 1);
  const today = todayIso();
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.tasks as t").innerJoin("app.ministries as m", "m.id", "t.ministry_id")
      .leftJoin("app.campaigns as c", "c.id", "t.campaign_id")
      .leftJoin("app.events as e", "e.id", "t.event_id")
      .where("m.is_demo", "=", f.mode === "demo")
      .where("t.removed_in_source_at", "is", null);
    if (isUuid(f.ministryId)) q = q.where("t.ministry_id", "=", f.ministryId);
    if (isUuid(f.campaignId)) q = q.where("t.campaign_id", "=", f.campaignId);
    if (isUuid(f.eventId)) q = q.where("t.event_id", "=", f.eventId);
    if (f.status === "completed") q = q.where("t.completed", "=", true);
    if (f.status === "open") q = q.where("t.completed", "=", false);
    if (f.status === "overdue") q = q.where("t.completed", "=", false).where("t.due_on", "<", today);
    if (f.source === "asana" || f.source === "manual") q = q.where("t.source", "=", f.source);
    if (f.q) q = q.where("t.name", "ilike", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
    // Período: concluídas no período OU com prazo no período.
    if (f.from && f.to) {
      q = q.where((eb) => eb.or([
        eb.and([eb("t.completed_at", ">=", new Date(`${f.from}T00:00:00-03:00`)), eb("t.completed_at", "<=", new Date(`${f.to}T23:59:59-03:00`))]),
        eb.and([eb("t.due_on", ">=", f.from!), eb("t.due_on", "<=", f.to!)]),
      ]));
    }
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q.select([
      "t.id", "t.name", "t.completed", "t.completed_at", "t.due_on", "t.assignee_name", "t.source", "t.permalink_url", "t.section_name",
      "t.classification", "t.ministry_id", "t.campaign_id", "t.event_id", "t.tags", "t.removed_in_source_at",
      "m.name as ministry_name", "c.name as campaign_name", "e.name as event_name",
    ]).orderBy("t.completed").orderBy("t.due_on", (ob) => ob.asc().nullsLast()).orderBy("t.created_at", "desc")
      .limit(pageSize).offset((page - 1) * pageSize).execute();
    return { total: Number(total.n), page, pageSize, rows };
  });
}

const manualTaskInput = z.object({
  ministryId: z.uuid("Selecione o ministério"),
  campaignId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  eventId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  name: z.string().trim().min(2, "Descreva a demanda").max(300),
  notes: z.string().trim().max(5000).optional().transform((v) => v || null),
  assigneeName: z.string().trim().max(120).optional().transform((v) => v || null),
  dueOn: z.union([z.literal(""), z.iso.date()]).optional().transform((v) => v || null),
});

export async function createManualTask(actor: Actor, raw: unknown): Promise<string> {
  const parsed = manualTaskInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const t = parsed.data;
  return asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.tasks").values({
      source: "manual", ministry_id: t.ministryId, campaign_id: t.campaignId, event_id: t.eventId, name: t.name, notes: t.notes,
      assignee_name: t.assigneeName, due_on: t.dueOn, classification: "manual", classification_reason: "Demanda cadastrada no portal", created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, { ministryId: t.ministryId, entityType: "task", entityId: row.id, action: "created", summary: `Demanda "${t.name}" cadastrada`, changes: { campaignId: t.campaignId } });
    return row.id;
  });
}

/** Conclui/reabre APENAS demandas manuais; demandas do Asana seguem a origem. */
export async function setManualTaskCompleted(actor: Actor, taskId: string, completed: boolean): Promise<void> {
  await asUser(actor, async (trx) => {
    const t = await trx.selectFrom("app.tasks").select(["source", "ministry_id", "name"]).where("id", "=", taskId).executeTakeFirst();
    if (!t) throw new ServiceError("Demanda não encontrada.", "not_found");
    if (t.source !== "manual") throw new ServiceError("O status de demandas do Asana é atualizado apenas pela sincronização.");
    const r = await trx.updateTable("app.tasks").set({ completed, completed_at: completed ? new Date() : null }).where("id", "=", taskId).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: t.ministry_id, entityType: "task", entityId: taskId, action: completed ? "completed" : "reopened", summary: `Demanda "${t.name}" ${completed ? "concluída" : "reaberta"}` });
  });
}

/** Associa (ou desassocia) uma demanda a campanha/evento do mesmo ministério. */
export async function linkTask(actor: Actor, taskId: string, campaignId: string | null, eventId: string | null): Promise<void> {
  await asUser(actor, async (trx) => {
    const t = await trx.selectFrom("app.tasks").select(["ministry_id", "campaign_id", "event_id", "name"]).where("id", "=", taskId).executeTakeFirst();
    if (!t) throw new ServiceError("Demanda não encontrada.", "not_found");
    const r = await trx.updateTable("app.tasks").set({ campaign_id: campaignId, event_id: eventId, classification: "manual", classification_reason: `Vínculo ajustado por ${actor.name}` })
      .where("id", "=", taskId).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: t.ministry_id, entityType: "task", entityId: taskId, action: "linked", summary: `Vínculos da demanda "${t.name}" atualizados`,
      changes: { campaignId, previousCampaignId: t.campaign_id, eventId, previousEventId: t.event_id } });
  });
}
