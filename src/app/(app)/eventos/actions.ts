"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/current";
import { toActionError, type ActionState } from "@/server/services/context";
import { addEventResult, createEvent, deleteEventResult, updateEvent, updateEventConsolidation } from "@/server/services/events";

function parseLinks(value: FormDataEntryValue | null): unknown {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

function eventFromForm(form: FormData) {
  return {
    ministryId: form.get("ministryId"), name: form.get("name"), description: form.get("description") ?? "",
    startsAt: form.get("startsAt") ?? "", endsAt: form.get("endsAt") ?? "", location: form.get("location") ?? "",
    communicationObjective: form.get("communicationObjective") ?? "", promotionStart: form.get("promotionStart") ?? "",
    promotionEnd: form.get("promotionEnd") ?? "", status: form.get("status") ?? "planned", links: parseLinks(form.get("links")),
    responsibleIds: form.getAll("responsibleIds"), campaignIds: form.getAll("campaignIds"),
  };
}

export async function saveEventAction(id: string | null, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let target: string;
  try {
    if (id) {
      await updateEvent(actor, id, eventFromForm(form));
      target = id;
    } else {
      target = await createEvent(actor, eventFromForm(form));
    }
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/eventos");
  redirect(`/eventos/${target}`);
}

export async function addEventResultAction(eventId: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await addEventResult(actor, eventId, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/eventos/${eventId}`);
  return { ok: true, message: "Resultado registrado." };
}

export async function deleteEventResultAction(eventId: string, resultId: string): Promise<void> {
  const actor = await requireActor();
  await deleteEventResult(actor, resultId);
  revalidatePath(`/eventos/${eventId}`);
}

export async function saveEventConsolidationAction(eventId: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const consolidate = form.get("intent") === "consolidate";
  try {
    await updateEventConsolidation(actor, eventId, {
      resultsSummary: String(form.get("resultsSummary") ?? ""), observations: String(form.get("observations") ?? ""), consolidate,
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/eventos/${eventId}`);
  revalidatePath("/eventos");
  return { ok: true, message: consolidate ? "Resultados consolidados. O evento foi marcado como realizado." : "Registro salvo." };
}
