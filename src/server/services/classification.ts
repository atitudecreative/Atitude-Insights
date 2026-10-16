import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { hasGlobalManage } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { asUser, ServiceError, zodErrors } from "./context";

export async function countUnclassified(actor: Actor): Promise<number> {
  if (!hasGlobalManage(actor)) return 0;
  return asUser(actor, async (trx) => {
    const [t, c, p] = await Promise.all([
      trx.selectFrom("app.tasks").select((eb) => eb.fn.countAll<number>().as("n")).where("ministry_id", "is", null).where("removed_in_source_at", "is", null).executeTakeFirstOrThrow(),
      trx.selectFrom("app.external_campaigns").select((eb) => eb.fn.countAll<number>().as("n")).where("ministry_id", "is", null).executeTakeFirstOrThrow(),
      trx.selectFrom("app.social_posts").select((eb) => eb.fn.countAll<number>().as("n")).where("ministry_id", "is", null).executeTakeFirstOrThrow(),
    ]);
    return Number(t.n) + Number(c.n) + Number(p.n);
  });
}

export async function listUnclassified(actor: Actor, limit = 100) {
  if (!hasGlobalManage(actor)) throw new ServiceError("Sem permissão.", "forbidden");
  return asUser(actor, async (trx) => {
    const [tasks, campaigns, posts] = await Promise.all([
      trx.selectFrom("app.tasks").select(["id", "name", "section_name", "projects", "classification_reason", "permalink_url", "created_at_source", "completed"])
        .where("ministry_id", "is", null).where("removed_in_source_at", "is", null).orderBy("created_at_source", "desc").limit(limit).execute(),
      trx.selectFrom("app.external_campaigns as c").innerJoin("app.external_assets as a", "a.id", "c.external_asset_id")
        .select(["c.id", "c.name", "c.effective_status", "c.classification_reason", "a.name as account_name", "c.start_time"])
        .where("c.ministry_id", "is", null).orderBy("c.start_time", "desc").limit(limit).execute(),
      trx.selectFrom("app.social_posts as p").innerJoin("app.external_assets as a", "a.id", "p.external_asset_id")
        .select(["p.id", "p.caption", "p.platform", "p.permalink", "p.published_at", "p.classification_reason", "a.name as account_name"])
        .where("p.ministry_id", "is", null).orderBy("p.published_at", "desc").limit(limit).execute(),
    ]);
    return { tasks, campaigns, posts };
  });
}

export const classifyInput = z.object({
  entity: z.enum(["task", "external_campaign", "social_post"]),
  id: z.uuid(),
  ministryId: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
  campaignId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  eventId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
});

/**
 * Classificação manual (ou correção de vínculo). Marca como 'manual' para que
 * sincronizações futuras não sobrescrevam a decisão humana. Registra histórico.
 */
export async function classifyItem(actor: Actor, raw: unknown): Promise<void> {
  const parsed = classifyInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Dados inválidos.", "invalid", zodErrors(parsed.error.issues));
  const { entity, id, ministryId, campaignId, eventId } = parsed.data;
  await asUser(actor, async (trx) => {
    const classification = ministryId ? "manual" : "unclassified";
    const reason = ministryId ? `Classificado manualmente por ${actor.name}` : "Devolvido à fila de revisão";
    let previous: string | null | undefined;
    if (entity === "task") {
      previous = (await trx.selectFrom("app.tasks").select("ministry_id").where("id", "=", id).executeTakeFirst())?.ministry_id;
      const r = await trx.updateTable("app.tasks").set({
        ministry_id: ministryId, campaign_id: ministryId ? campaignId : null, event_id: ministryId ? eventId : null,
        classification, classification_reason: reason,
      }).where("id", "=", id).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Item não encontrado ou sem permissão.", "not_found");
    } else if (entity === "external_campaign") {
      previous = (await trx.selectFrom("app.external_campaigns").select("ministry_id").where("id", "=", id).executeTakeFirst())?.ministry_id;
      const r = await trx.updateTable("app.external_campaigns").set({ ministry_id: ministryId, classification, classification_reason: reason })
        .where("id", "=", id).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Item não encontrado ou sem permissão.", "not_found");
      if (ministryId && campaignId) {
        await trx.insertInto("app.campaign_external_campaigns").values({ campaign_id: campaignId, external_campaign_id: id })
          .onConflict((oc) => oc.doNothing()).execute();
      }
    } else {
      previous = (await trx.selectFrom("app.social_posts").select("ministry_id").where("id", "=", id).executeTakeFirst())?.ministry_id;
      const r = await trx.updateTable("app.social_posts").set({ ministry_id: ministryId, classification, classification_reason: reason })
        .where("id", "=", id).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Item não encontrado ou sem permissão.", "not_found");
      if (ministryId && campaignId) {
        await trx.insertInto("app.campaign_social_posts").values({ campaign_id: campaignId, social_post_id: id }).onConflict((oc) => oc.doNothing()).execute();
      }
    }
    await audit(trx, {
      ministryId, entityType: entity, entityId: id, action: "classified",
      summary: ministryId ? "Item classificado manualmente" : "Classificação removida",
      changes: { from: previous ?? null, to: ministryId, campaignId, eventId },
    });
  });
}
