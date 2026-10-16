import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { sql, type Tx } from "@/server/db";
import { asUser, isUuid, ministryAccess, ServiceError, zodErrors, type MinistryAccess } from "./context";
import type { DataMode } from "./mode";

export const CAMPAIGN_STATUSES = ["planning", "production", "awaiting_approval", "scheduled", "active", "completed", "archived"] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const optionalDate = z.union([z.literal(""), z.iso.date("Data inválida")]).optional().transform((v) => v || null);
const uuidList = z.array(z.uuid()).max(50).default([]);

export const campaignInput = z.object({
  ministryId: z.uuid("Selecione o ministério"),
  name: z.string().trim().min(2, "Informe o nome").max(200),
  description: optionalText(5000),
  objective: optionalText(2000),
  targetAudience: optionalText(1000),
  startDate: optionalDate,
  endDate: optionalDate,
  status: z.enum(CAMPAIGN_STATUSES).default("planning"),
  channelIds: uuidList,
  responsibleIds: uuidList,
  eventIds: uuidList,
  plannedInvestment: z.union([z.literal(""), z.coerce.number().min(0, "Valor inválido").max(1e9)]).optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
}).refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: "O término deve ser após o início", path: ["endDate"] });

export type CampaignInput = z.input<typeof campaignInput>;

export interface CampaignListFilters {
  mode: DataMode;
  ministryId?: string;
  status?: string;
  eventId?: string;
  channelKey?: string;
  q?: string;
  activeOn?: string;
  page?: number;
  pageSize?: number;
}

export async function listCampaigns(actor: Actor, f: CampaignListFilters) {
  const pageSize = f.pageSize ?? 20;
  const page = Math.max(1, f.page ?? 1);
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.campaigns as c")
      .innerJoin("app.ministries as m", "m.id", "c.ministry_id")
      .where("m.is_demo", "=", f.mode === "demo");
    if (isUuid(f.ministryId)) q = q.where("c.ministry_id", "=", f.ministryId);
    if (f.status && (CAMPAIGN_STATUSES as readonly string[]).includes(f.status)) q = q.where("c.status", "=", f.status);
    else q = q.where("c.status", "<>", "archived");
    if (isUuid(f.eventId)) q = q.where((eb) => eb.exists(eb.selectFrom("app.campaign_events as ce").select("ce.event_id").whereRef("ce.campaign_id", "=", "c.id").where("ce.event_id", "=", f.eventId!)));
    if (f.channelKey) {
      q = q.where((eb) => eb.exists(eb.selectFrom("app.campaign_channels as cc").innerJoin("app.channels as ch", "ch.id", "cc.channel_id")
        .select("cc.channel_id").whereRef("cc.campaign_id", "=", "c.id").where("ch.key", "=", f.channelKey!)));
    }
    if (f.q) q = q.where("c.name", "ilike", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
    if (f.activeOn) q = q.where((eb) => eb.and([eb.or([eb("c.start_date", "is", null), eb("c.start_date", "<=", f.activeOn!)]), eb.or([eb("c.end_date", "is", null), eb("c.end_date", ">=", f.activeOn!)])]));

    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q
      .select((eb) => [
        "c.id", "c.name", "c.status", "c.start_date", "c.end_date", "c.objective", "c.ministry_id", "m.name as ministry_name", "m.slug as ministry_slug", "m.color as ministry_color",
        eb.selectFrom("app.tasks as t").select((e) => e.fn.countAll<number>().as("n")).whereRef("t.campaign_id", "=", "c.id").as("tasks_total"),
        eb.selectFrom("app.tasks as t").select((e) => e.fn.countAll<number>().as("n")).whereRef("t.campaign_id", "=", "c.id").where("t.completed", "=", true).as("tasks_done"),
        eb.selectFrom("app.deliverables as d").select((e) => e.fn.countAll<number>().as("n")).whereRef("d.campaign_id", "=", "c.id").as("deliverables_total"),
      ])
      .orderBy("c.start_date", (ob) => ob.desc().nullsLast())
      .orderBy("c.created_at", "desc")
      .limit(pageSize).offset((page - 1) * pageSize)
      .execute();
    const ids = rows.map((r) => r.id);
    const channels = ids.length
      ? await trx.selectFrom("app.campaign_channels as cc").innerJoin("app.channels as ch", "ch.id", "cc.channel_id")
        .select(["cc.campaign_id", "ch.name", "ch.key"]).where("cc.campaign_id", "in", ids).execute()
      : [];
    return {
      total: Number(total.n), page, pageSize,
      rows: rows.map((r) => ({
        ...r, tasks_total: Number(r.tasks_total ?? 0), tasks_done: Number(r.tasks_done ?? 0), deliverables_total: Number(r.deliverables_total ?? 0),
        channels: channels.filter((c) => c.campaign_id === r.id).map((c) => ({ key: c.key, name: c.name })),
      })),
    };
  });
}

async function loadCampaignRelations(trx: Tx, campaignId: string) {
  const [channels, responsibles, events] = await Promise.all([
    trx.selectFrom("app.campaign_channels as cc").innerJoin("app.channels as ch", "ch.id", "cc.channel_id")
      .select(["ch.id", "ch.key", "ch.name", "ch.kind"]).where("cc.campaign_id", "=", campaignId).orderBy("ch.sort_order").execute(),
    trx.selectFrom("app.campaign_responsibles as r").innerJoin("app.users as u", "u.id", "r.user_id")
      .select(["u.id", "u.name"]).where("r.campaign_id", "=", campaignId).execute(),
    trx.selectFrom("app.campaign_events as ce").innerJoin("app.events as e", "e.id", "ce.event_id")
      .select(["e.id", "e.name", "e.starts_at", "e.status", "e.location"]).where("ce.campaign_id", "=", campaignId).orderBy("e.starts_at").execute(),
  ]);
  return { channels, responsibles, events };
}

export async function getCampaign(actor: Actor, id: string) {
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const campaign = await trx.selectFrom("app.campaigns as c").innerJoin("app.ministries as m", "m.id", "c.ministry_id")
      .select(["c.id", "c.ministry_id", "c.name", "c.description", "c.objective", "c.target_audience", "c.start_date", "c.end_date", "c.status",
        "c.final_summary", "c.learnings", "c.observations", "c.created_at", "c.updated_at",
        "m.name as ministry_name", "m.slug as ministry_slug", "m.is_demo"])
      .where("c.id", "=", id).executeTakeFirst();
    if (!campaign) return null;
    const access: MinistryAccess = await ministryAccess(trx, campaign.ministry_id);
    const [relations, goals, tasks, deliverables, externalCampaigns, posts, investments, history] = await Promise.all([
      loadCampaignRelations(trx, id),
      trx.selectFrom("app.campaign_goals").select(["id", "label", "metric_key", "target_value", "unit", "manual_actual_value", "manual_actual_source", "notes"])
        .where("campaign_id", "=", id).orderBy("created_at").execute(),
      trx.selectFrom("app.tasks").select(["id", "name", "completed", "completed_at", "due_on", "assignee_name", "source", "permalink_url", "section_name", "removed_in_source_at"])
        .where("campaign_id", "=", id).orderBy("completed").orderBy("due_on", (ob) => ob.asc().nullsLast()).execute(),
      trx.selectFrom("app.deliverables").select(["id", "title", "type", "status", "url", "due_date", "delivered_at", "approved_at"])
        .where("campaign_id", "=", id).orderBy("created_at", "desc").execute(),
      trx.selectFrom("app.campaign_external_campaigns as l").innerJoin("app.external_campaigns as e", "e.id", "l.external_campaign_id")
        .innerJoin("app.external_assets as a", "a.id", "e.external_asset_id")
        .select(["e.id", "e.name", "e.objective", "e.effective_status", "e.start_time", "e.stop_time", "a.name as account_name"])
        .where("l.campaign_id", "=", id).execute(),
      trx.selectFrom("app.campaign_social_posts as l").innerJoin("app.social_posts as p", "p.id", "l.social_post_id")
        .select(["p.id", "p.platform", "p.caption", "p.permalink", "p.published_at", "p.media_type", "p.thumbnail_url"])
        .where("l.campaign_id", "=", id).orderBy("p.published_at", "desc").execute(),
      access.canViewInvestment
        ? trx.selectFrom("app.investments").select(["id", "kind", "category", "description", "amount", "currency", "spent_on"])
          .where("campaign_id", "=", id).orderBy("spent_on", (ob) => ob.desc().nullsLast()).execute()
        : Promise.resolve(null),
      trx.selectFrom("app.activity_logs as l").leftJoin("app.users as u", "u.id", "l.actor_user_id")
        .select(["l.id", "l.action", "l.summary", "l.created_at", "u.name as actor_name"])
        .where("l.entity_type", "in", ["campaign", "task", "deliverable", "investment", "goal"])
        .where((eb) => eb.or([eb("l.entity_id", "=", id), eb(sql<string>`l.changes->>'campaignId'`, "=", id)]))
        .orderBy("l.created_at", "desc").limit(30).execute(),
    ]);
    return { campaign, access, ...relations, goals, tasks, deliverables, externalCampaigns, posts, investments, history };
  });
}

async function syncRelations(trx: Tx, campaignId: string, input: { channelIds: string[]; responsibleIds: string[]; eventIds: string[] }) {
  await trx.deleteFrom("app.campaign_channels").where("campaign_id", "=", campaignId).execute();
  if (input.channelIds.length) await trx.insertInto("app.campaign_channels").values(input.channelIds.map((channel_id) => ({ campaign_id: campaignId, channel_id }))).execute();
  await trx.deleteFrom("app.campaign_responsibles").where("campaign_id", "=", campaignId).execute();
  if (input.responsibleIds.length) await trx.insertInto("app.campaign_responsibles").values(input.responsibleIds.map((user_id) => ({ campaign_id: campaignId, user_id }))).execute();
  await trx.deleteFrom("app.campaign_events").where("campaign_id", "=", campaignId).execute();
  if (input.eventIds.length) await trx.insertInto("app.campaign_events").values(input.eventIds.map((event_id) => ({ campaign_id: campaignId, event_id }))).execute();
}

function parseCampaign(raw: unknown) {
  const parsed = campaignInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos destacados.", "invalid", zodErrors(parsed.error.issues));
  return parsed.data;
}

export async function createCampaign(actor: Actor, raw: unknown): Promise<string> {
  const input = parseCampaign(raw);
  return asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.campaigns").values({
      ministry_id: input.ministryId, name: input.name, description: input.description, objective: input.objective,
      target_audience: input.targetAudience, start_date: input.startDate, end_date: input.endDate, status: input.status, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await syncRelations(trx, row.id, input);
    if (input.plannedInvestment != null) {
      await trx.insertInto("app.investments").values({
        ministry_id: input.ministryId, campaign_id: row.id, kind: "planned", category: "midia_paga",
        description: "Investimento planejado (cadastro da campanha)", amount: input.plannedInvestment, created_by: actor.userId,
      }).execute();
    }
    await audit(trx, { ministryId: input.ministryId, entityType: "campaign", entityId: row.id, action: "created", summary: `Campanha "${input.name}" criada` });
    return row.id;
  });
}

export async function updateCampaign(actor: Actor, id: string, raw: unknown): Promise<void> {
  const input = parseCampaign(raw);
  await asUser(actor, async (trx) => {
    const before = await trx.selectFrom("app.campaigns").select(["ministry_id", "status", "name", "start_date", "end_date"]).where("id", "=", id).executeTakeFirst();
    if (!before) throw new ServiceError("Campanha não encontrada.", "not_found");
    if (before.ministry_id !== input.ministryId) throw new ServiceError("Não é possível mover a campanha para outro ministério.", "invalid");
    const r = await trx.updateTable("app.campaigns").set({
      name: input.name, description: input.description, objective: input.objective, target_audience: input.targetAudience,
      start_date: input.startDate, end_date: input.endDate, status: input.status, archived_at: input.status === "archived" ? new Date() : null,
    }).where("id", "=", id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Sem permissão para editar esta campanha.", "forbidden");
    await syncRelations(trx, id, input);
    const changes: Record<string, unknown> = {};
    for (const k of ["status", "name", "start_date", "end_date"] as const) {
      const after = { status: input.status, name: input.name, start_date: input.startDate, end_date: input.endDate }[k];
      if (before[k] !== after) changes[k] = { from: before[k], to: after };
    }
    await audit(trx, { ministryId: before.ministry_id, entityType: "campaign", entityId: id, action: "updated", summary: `Campanha "${input.name}" atualizada`, changes });
  });
}

export const reportNotesInput = z.object({
  finalSummary: optionalText(10000),
  learnings: optionalText(10000),
  observations: optionalText(10000),
});

export async function updateCampaignNotes(actor: Actor, id: string, raw: unknown): Promise<void> {
  const parsed = reportNotesInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Dados inválidos.", "invalid", zodErrors(parsed.error.issues));
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.campaigns").set({ final_summary: parsed.data.finalSummary, learnings: parsed.data.learnings, observations: parsed.data.observations })
      .where("id", "=", id).returning("ministry_id").executeTakeFirst();
    if (!r) throw new ServiceError("Sem permissão.", "forbidden");
    await audit(trx, { ministryId: r.ministry_id, entityType: "campaign", entityId: id, action: "notes_updated", summary: "Resultados e aprendizados atualizados" });
  });
}

export const goalInput = z.object({
  label: z.string().trim().min(2, "Descreva a meta").max(200),
  metricKey: z.string().trim().max(60).optional().transform((v) => v || null),
  targetValue: z.coerce.number().min(0, "Meta inválida").max(1e12),
  unit: z.enum(["count", "currency", "percent"]).default("count"),
  manualActualValue: z.union([z.literal(""), z.coerce.number().min(0)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  manualActualSource: optionalText(300),
  notes: optionalText(1000),
}).refine((v) => v.manualActualValue == null || v.manualActualSource, { message: "Informe a fonte do valor realizado", path: ["manualActualSource"] });

export async function addGoal(actor: Actor, campaignId: string, raw: unknown): Promise<void> {
  const parsed = goalInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const g = parsed.data;
  await asUser(actor, async (trx) => {
    const c = await trx.selectFrom("app.campaigns").select("ministry_id").where("id", "=", campaignId).executeTakeFirst();
    if (!c) throw new ServiceError("Campanha não encontrada.", "not_found");
    const row = await trx.insertInto("app.campaign_goals").values({
      ministry_id: c.ministry_id, campaign_id: campaignId, label: g.label, metric_key: g.metricKey, target_value: g.targetValue, unit: g.unit,
      manual_actual_value: g.manualActualValue, manual_actual_source: g.manualActualSource, notes: g.notes,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, { ministryId: c.ministry_id, entityType: "goal", entityId: row.id, action: "created", summary: `Meta "${g.label}" adicionada`, changes: { campaignId } });
  });
}

export async function deleteGoal(actor: Actor, goalId: string): Promise<void> {
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.campaign_goals").where("id", "=", goalId).returning(["ministry_id", "campaign_id", "label"]).executeTakeFirst();
    if (!r) throw new ServiceError("Meta não encontrada ou sem permissão.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "goal", entityId: goalId, action: "deleted", summary: `Meta "${r.label}" removida`, changes: { campaignId: r.campaign_id } });
  });
}

/** Vínculo explícito campanha de comunicação ⇄ campanha da Meta ou publicação. */
export async function linkMarketingItem(actor: Actor, campaignId: string, kind: "external_campaign" | "social_post", itemId: string, link: boolean): Promise<void> {
  if (!isUuid(campaignId) || !isUuid(itemId)) throw new ServiceError("Dados inválidos.");
  await asUser(actor, async (trx) => {
    const c = await trx.selectFrom("app.campaigns").select(["ministry_id", "name"]).where("id", "=", campaignId).executeTakeFirst();
    if (!c) throw new ServiceError("Campanha não encontrada.", "not_found");
    if (kind === "external_campaign") {
      if (link) await trx.insertInto("app.campaign_external_campaigns").values({ campaign_id: campaignId, external_campaign_id: itemId }).onConflict((oc) => oc.doNothing()).execute();
      else await trx.deleteFrom("app.campaign_external_campaigns").where("campaign_id", "=", campaignId).where("external_campaign_id", "=", itemId).execute();
    } else {
      if (link) await trx.insertInto("app.campaign_social_posts").values({ campaign_id: campaignId, social_post_id: itemId }).onConflict((oc) => oc.doNothing()).execute();
      else await trx.deleteFrom("app.campaign_social_posts").where("campaign_id", "=", campaignId).where("social_post_id", "=", itemId).execute();
    }
    await audit(trx, { ministryId: c.ministry_id, entityType: "campaign", entityId: campaignId, action: link ? "linked" : "unlinked",
      summary: `${kind === "external_campaign" ? "Campanha da Meta" : "Publicação"} ${link ? "vinculada" : "desvinculada"}`, changes: { kind, itemId } });
  });
}

/** Itens da Meta do mesmo ministério ainda não vinculados (para o seletor). */
export async function linkCandidates(actor: Actor, campaignId: string) {
  return asUser(actor, async (trx) => {
    const c = await trx.selectFrom("app.campaigns").select("ministry_id").where("id", "=", campaignId).executeTakeFirst();
    if (!c) return { externalCampaigns: [], posts: [] };
    const [externalCampaigns, posts] = await Promise.all([
      trx.selectFrom("app.external_campaigns as e").select(["e.id", "e.name", "e.effective_status", "e.start_time"])
        .where("e.ministry_id", "=", c.ministry_id)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("app.campaign_external_campaigns as l").select("l.campaign_id").whereRef("l.external_campaign_id", "=", "e.id").where("l.campaign_id", "=", campaignId))))
        .orderBy("e.start_time", "desc").limit(100).execute(),
      trx.selectFrom("app.social_posts as p").select(["p.id", "p.caption", "p.platform", "p.published_at"])
        .where("p.ministry_id", "=", c.ministry_id)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("app.campaign_social_posts as l").select("l.campaign_id").whereRef("l.social_post_id", "=", "p.id").where("l.campaign_id", "=", campaignId))))
        .orderBy("p.published_at", "desc").limit(100).execute(),
    ]);
    return { externalCampaigns, posts };
  });
}

/** Opções para formulários (escopo do usuário). */
export async function campaignFormOptions(actor: Actor, mode: DataMode) {
  return asUser(actor, async (trx) => {
    const [ministries, channels, users, events] = await Promise.all([
      trx.selectFrom("app.ministries").select(["id", "name"]).where("status", "=", "active").where("is_demo", "=", mode === "demo").orderBy("name").execute(),
      trx.selectFrom("app.channels").select(["id", "name", "key"]).where("active", "=", true).orderBy("sort_order").execute(),
      trx.selectFrom("app.users").select(["id", "name", "global_role"]).where("status", "=", "active").where("deleted_at", "is", null)
        .where("global_role", "in", ["agency", "superadmin"]).orderBy("name").execute(),
      trx.selectFrom("app.events as e").innerJoin("app.ministries as m", "m.id", "e.ministry_id")
        .select(["e.id", "e.name", "e.ministry_id", "e.starts_at"]).where("m.is_demo", "=", mode === "demo").where("e.archived_at", "is", null)
        .orderBy("e.starts_at", "desc").limit(200).execute(),
    ]);
    const manageable: string[] = [];
    for (const m of ministries) if ((await ministryAccess(trx, m.id)).canManage) manageable.push(m.id);
    return { ministries: ministries.filter((m) => manageable.includes(m.id)), channels, users, events };
  });
}
