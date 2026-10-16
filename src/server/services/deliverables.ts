import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { asUser, isUuid, ministryAccess, ServiceError, zodErrors } from "./context";
import type { DataMode } from "./mode";

export const DELIVERABLE_TYPES = ["arte", "video", "reels", "story", "carrossel", "landing_page", "email", "impresso", "identidade_visual", "fotografia", "texto", "anuncio", "outro"] as const;
export const DELIVERABLE_STATUSES = ["in_production", "in_review", "changes_requested", "approved", "delivered", "cancelled"] as const;

export const deliverableInput = z.object({
  ministryId: z.uuid("Selecione o ministério"),
  campaignId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  eventId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  taskId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  title: z.string().trim().min(2, "Informe o título").max(200),
  description: z.string().trim().max(3000).optional().transform((v) => v || null),
  type: z.enum(DELIVERABLE_TYPES),
  status: z.enum(DELIVERABLE_STATUSES).default("in_production"),
  url: z.union([z.literal(""), z.url().refine((u) => /^https?:\/\//i.test(u), "Use um link http(s)")]).optional().transform((v) => v || null),
  dueDate: z.union([z.literal(""), z.iso.date()]).optional().transform((v) => v || null),
});

export async function listDeliverables(actor: Actor, f: { mode: DataMode; ministryId?: string; campaignId?: string; eventId?: string; status?: string; type?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  const pageSize = f.pageSize ?? 24;
  const page = Math.max(1, f.page ?? 1);
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.deliverables as d").innerJoin("app.ministries as m", "m.id", "d.ministry_id")
      .leftJoin("app.campaigns as c", "c.id", "d.campaign_id").leftJoin("app.events as e", "e.id", "d.event_id")
      .where("m.is_demo", "=", f.mode === "demo");
    if (isUuid(f.ministryId)) q = q.where("d.ministry_id", "=", f.ministryId);
    if (isUuid(f.campaignId)) q = q.where("d.campaign_id", "=", f.campaignId);
    if (isUuid(f.eventId)) q = q.where("d.event_id", "=", f.eventId);
    if (f.status && (DELIVERABLE_STATUSES as readonly string[]).includes(f.status)) q = q.where("d.status", "=", f.status);
    if (f.type && (DELIVERABLE_TYPES as readonly string[]).includes(f.type)) q = q.where("d.type", "=", f.type);
    if (f.from && f.to) q = q.where("d.created_at", ">=", new Date(`${f.from}T00:00:00-03:00`)).where("d.created_at", "<=", new Date(`${f.to}T23:59:59-03:00`));
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q.select(["d.id", "d.title", "d.type", "d.status", "d.url", "d.due_date", "d.delivered_at", "d.approved_at", "d.created_at", "d.ministry_id",
      "m.name as ministry_name", "c.id as campaign_id", "c.name as campaign_name", "e.name as event_name"])
      .orderBy("d.created_at", "desc").limit(pageSize).offset((page - 1) * pageSize).execute();
    return { total: Number(total.n), page, pageSize, rows };
  });
}

export async function getDeliverable(actor: Actor, id: string) {
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const d = await trx.selectFrom("app.deliverables as d").innerJoin("app.ministries as m", "m.id", "d.ministry_id")
      .leftJoin("app.campaigns as c", "c.id", "d.campaign_id").leftJoin("app.events as e", "e.id", "d.event_id")
      .leftJoin("app.tasks as t", "t.id", "d.task_id").leftJoin("app.users as au", "au.id", "d.approved_by")
      .select(["d.id", "d.ministry_id", "d.campaign_id", "d.event_id", "d.task_id", "d.title", "d.description", "d.type", "d.status", "d.url", "d.due_date",
        "d.delivered_at", "d.approved_at", "d.created_at", "m.name as ministry_name", "c.name as campaign_name", "e.name as event_name", "t.name as task_name",
        "t.permalink_url as task_url", "au.name as approved_by_name"])
      .where("d.id", "=", id).executeTakeFirst();
    if (!d) return null;
    const [access, comments] = await Promise.all([
      ministryAccess(trx, d.ministry_id),
      trx.selectFrom("app.deliverable_comments as c").leftJoin("app.users as u", "u.id", "c.user_id")
        .select(["c.id", "c.body", "c.created_at", "u.name as author"]).where("c.deliverable_id", "=", id).orderBy("c.created_at").execute(),
    ]);
    return { deliverable: d, access, comments };
  });
}

function parse(raw: unknown) {
  const parsed = deliverableInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos destacados.", "invalid", zodErrors(parsed.error.issues));
  return parsed.data;
}

export async function createDeliverable(actor: Actor, raw: unknown): Promise<string> {
  const d = parse(raw);
  return asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.deliverables").values({
      ministry_id: d.ministryId, campaign_id: d.campaignId, event_id: d.eventId, task_id: d.taskId, title: d.title, description: d.description,
      type: d.type, status: d.status, url: d.url, due_date: d.dueDate, delivered_at: d.status === "delivered" ? new Date() : null, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, { ministryId: d.ministryId, entityType: "deliverable", entityId: row.id, action: "created", summary: `Entregável "${d.title}" registrado`, changes: { campaignId: d.campaignId } });
    return row.id;
  });
}

export async function updateDeliverable(actor: Actor, id: string, raw: unknown): Promise<void> {
  const d = parse(raw);
  await asUser(actor, async (trx) => {
    const before = await trx.selectFrom("app.deliverables").select(["ministry_id", "status", "delivered_at"]).where("id", "=", id).executeTakeFirst();
    if (!before) throw new ServiceError("Entregável não encontrado.", "not_found");
    if (before.ministry_id !== d.ministryId) throw new ServiceError("Não é possível mover o entregável para outro ministério.");
    const r = await trx.updateTable("app.deliverables").set({
      campaign_id: d.campaignId, event_id: d.eventId, task_id: d.taskId, title: d.title, description: d.description, type: d.type, status: d.status,
      url: d.url, due_date: d.dueDate, delivered_at: d.status === "delivered" ? (before.delivered_at ?? new Date()) : before.delivered_at,
    }).where("id", "=", id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: d.ministryId, entityType: "deliverable", entityId: id, action: "updated", summary: `Entregável "${d.title}" atualizado`,
      changes: { campaignId: d.campaignId, ...(before.status !== d.status ? { status: { from: before.status, to: d.status } } : {}) } });
  });
}

/** Aprovação / pedido de ajustes (liderança operacional ou agência). */
export async function reviewDeliverable(actor: Actor, id: string, decision: "approved" | "changes_requested", comment?: string): Promise<void> {
  await asUser(actor, async (trx) => {
    const d = await trx.selectFrom("app.deliverables").select(["ministry_id", "title"]).where("id", "=", id).executeTakeFirst();
    if (!d) throw new ServiceError("Entregável não encontrado.", "not_found");
    const access = await ministryAccess(trx, d.ministry_id);
    if (!access.canCollaborate) throw new ServiceError("Seu perfil não pode aprovar entregáveis.", "forbidden");
    await trx.updateTable("app.deliverables").set({
      status: decision, approved_by: decision === "approved" ? actor.userId : null, approved_at: decision === "approved" ? new Date() : null,
    }).where("id", "=", id).execute();
    if (comment?.trim()) {
      await trx.insertInto("app.deliverable_comments").values({ ministry_id: d.ministry_id, deliverable_id: id, user_id: actor.userId, body: comment.trim().slice(0, 4000) }).execute();
    }
    await audit(trx, { ministryId: d.ministry_id, entityType: "deliverable", entityId: id, action: decision, summary: `Entregável "${d.title}" ${decision === "approved" ? "aprovado" : "com ajustes solicitados"}` });
  });
}

export async function commentDeliverable(actor: Actor, id: string, body: string): Promise<void> {
  const text = body.trim();
  if (text.length < 1 || text.length > 4000) throw new ServiceError("Comentário inválido.");
  await asUser(actor, async (trx) => {
    const d = await trx.selectFrom("app.deliverables").select("ministry_id").where("id", "=", id).executeTakeFirst();
    if (!d) throw new ServiceError("Entregável não encontrado.", "not_found");
    await trx.insertInto("app.deliverable_comments").values({ ministry_id: d.ministry_id, deliverable_id: id, user_id: actor.userId, body: text }).execute();
    await audit(trx, { ministryId: d.ministry_id, entityType: "deliverable", entityId: id, action: "commented", summary: "Novo comentário" });
  });
}
