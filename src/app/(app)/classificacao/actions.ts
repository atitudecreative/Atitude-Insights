"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/server/auth/current";
import { classifyItem } from "@/server/services/classification";
import { toActionError, type ActionState } from "@/server/services/context";

export async function classifyItemAction(entity: "task" | "external_campaign" | "social_post", id: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await classifyItem(actor, {
      entity, id, ministryId: form.get("ministryId") ?? "",
      campaignId: form.get("campaignId") ?? "", eventId: entity === "task" ? form.get("eventId") ?? "" : "",
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/classificacao");
  revalidatePath("/", "layout");
  return { ok: true, message: "Item classificado." };
}
