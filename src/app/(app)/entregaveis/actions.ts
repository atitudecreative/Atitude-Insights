"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/current";
import { toActionError, type ActionState } from "@/server/services/context";
import { commentDeliverable, createDeliverable, reviewDeliverable, updateDeliverable } from "@/server/services/deliverables";

function deliverableFromForm(form: FormData) {
  return {
    ministryId: form.get("ministryId"), campaignId: form.get("campaignId") ?? "", eventId: form.get("eventId") ?? "", taskId: form.get("taskId") ?? "",
    title: form.get("title"), description: form.get("description") ?? "", type: form.get("type"), status: form.get("status") ?? "in_production",
    url: form.get("url") ?? "", dueDate: form.get("dueDate") ?? "",
  };
}

export async function saveDeliverableAction(id: string | null, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let target: string;
  try {
    if (id) {
      await updateDeliverable(actor, id, deliverableFromForm(form));
      target = id;
    } else {
      target = await createDeliverable(actor, deliverableFromForm(form));
    }
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/entregaveis");
  redirect(`/entregaveis/${target}`);
}

export async function reviewDeliverableAction(id: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const decision = form.get("intent") === "approved" ? "approved" : "changes_requested";
  const comment = String(form.get("comment") ?? "");
  if (decision === "changes_requested" && comment.trim().length < 2) {
    return { ok: false, message: "Descreva os ajustes solicitados no comentário.", errors: { comment: ["Descreva os ajustes solicitados."] } };
  }
  try {
    await reviewDeliverable(actor, id, decision, comment);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/entregaveis/${id}`);
  revalidatePath("/entregaveis");
  return { ok: true, message: decision === "approved" ? "Entregável aprovado." : "Ajustes solicitados." };
}

export async function commentDeliverableAction(id: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await commentDeliverable(actor, id, String(form.get("body") ?? ""));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/entregaveis/${id}`);
  return { ok: true, message: "Comentário publicado." };
}
