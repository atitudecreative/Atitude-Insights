import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { asUser, ServiceError, zodErrors } from "./context";

export const investmentInput = z.object({
  ministryId: z.uuid(),
  campaignId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  eventId: z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null),
  kind: z.enum(["planned", "realized"]),
  category: z.enum(["midia_paga", "producao", "impressao", "impulsionamento", "ferramentas", "outro"]),
  description: z.string().trim().min(2, "Descreva o investimento").max(300),
  amount: z.coerce.number({ message: "Valor inválido" }).min(0, "Valor inválido").max(1e9),
  spentOn: z.union([z.literal(""), z.iso.date()]).optional().transform((v) => v || null),
});

export async function addInvestment(actor: Actor, raw: unknown): Promise<void> {
  const parsed = investmentInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const i = parsed.data;
  await asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.investments").values({
      ministry_id: i.ministryId, campaign_id: i.campaignId, event_id: i.eventId, kind: i.kind, category: i.category, description: i.description,
      amount: i.amount, spent_on: i.spentOn, created_by: actor.userId,
    }).returning("id").executeTakeFirstOrThrow();
    await audit(trx, { ministryId: i.ministryId, entityType: "investment", entityId: row.id, action: "created",
      summary: `Investimento ${i.kind === "planned" ? "planejado" : "realizado"} registrado`, changes: { campaignId: i.campaignId } });
  });
}

export async function deleteInvestment(actor: Actor, id: string): Promise<void> {
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.investments").where("id", "=", id).returning(["ministry_id", "campaign_id"]).executeTakeFirst();
    if (!r) throw new ServiceError("Registro não encontrado ou sem permissão.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "investment", entityId: id, action: "deleted", summary: "Investimento removido", changes: { campaignId: r.campaign_id } });
  });
}
