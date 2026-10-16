"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/server/auth/current";
import { isUuid, toActionError, type ActionState } from "@/server/services/context";
import { createManualTask, linkTask, setManualTaskCompleted } from "@/server/services/tasks";

export async function createTaskAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await createManualTask(actor, {
      ministryId: form.get("ministryId"), campaignId: form.get("campaignId") ?? "", eventId: form.get("eventId") ?? "",
      name: form.get("name"), notes: form.get("notes") ?? "", assigneeName: form.get("assigneeName") ?? "", dueOn: form.get("dueOn") ?? "",
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/demandas");
  return { ok: true, message: "Demanda cadastrada." };
}

export async function linkTaskAction(taskId: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const campaignId = form.get("campaignId");
  const eventId = form.get("eventId");
  if ((campaignId && !isUuid(campaignId)) || (eventId && !isUuid(eventId))) return { ok: false, message: "Seleção inválida." };
  try {
    await linkTask(actor, taskId, isUuid(campaignId) ? campaignId : null, isUuid(eventId) ? eventId : null);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/demandas");
  return { ok: true, message: "Vínculos atualizados." };
}

export async function setTaskCompletedAction(taskId: string, completed: boolean): Promise<void> {
  const actor = await requireActor();
  await setManualTaskCompleted(actor, taskId, completed);
  revalidatePath("/demandas");
}
