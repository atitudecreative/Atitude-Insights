"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/current";
import { addGoal, createCampaign, deleteGoal, linkMarketingItem, updateCampaign, updateCampaignNotes } from "@/server/services/campaigns";
import { toActionError, type ActionState } from "@/server/services/context";
import { addInvestment, deleteInvestment } from "@/server/services/investments";

function campaignFromForm(form: FormData) {
  return {
    ministryId: form.get("ministryId"), name: form.get("name"), description: form.get("description") ?? "", objective: form.get("objective") ?? "",
    targetAudience: form.get("targetAudience") ?? "", startDate: form.get("startDate") ?? "", endDate: form.get("endDate") ?? "",
    status: form.get("status") ?? "planning", channelIds: form.getAll("channelIds"), responsibleIds: form.getAll("responsibleIds"),
    eventIds: form.getAll("eventIds"), plannedInvestment: form.get("plannedInvestment") ?? "",
  };
}

export async function saveCampaignAction(id: string | null, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let target: string;
  try {
    if (id) {
      await updateCampaign(actor, id, campaignFromForm(form));
      target = id;
    } else {
      target = await createCampaign(actor, campaignFromForm(form));
    }
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/campanhas");
  redirect(`/campanhas/${target}`);
}

export async function saveCampaignNotesAction(id: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await updateCampaignNotes(actor, id, { finalSummary: form.get("finalSummary") ?? "", learnings: form.get("learnings") ?? "", observations: form.get("observations") ?? "" });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/campanhas/${id}`);
  return { ok: true, message: "Registro salvo." };
}

export async function addGoalAction(campaignId: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await addGoal(actor, campaignId, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/campanhas/${campaignId}`);
  return { ok: true, message: "Meta adicionada." };
}

export async function deleteGoalAction(campaignId: string, goalId: string): Promise<void> {
  const actor = await requireActor();
  await deleteGoal(actor, goalId);
  revalidatePath(`/campanhas/${campaignId}`);
}

export async function addInvestmentAction(path: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await addInvestment(actor, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  return { ok: true, message: "Investimento registrado." };
}

export async function deleteInvestmentAction(path: string, id: string): Promise<void> {
  const actor = await requireActor();
  await deleteInvestment(actor, id);
  revalidatePath(path);
}

export async function linkItemAction(campaignId: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const kind = form.get("kind") === "social_post" ? "social_post" : "external_campaign";
  const itemId = String(form.get("itemId") ?? "");
  try {
    await linkMarketingItem(actor, campaignId, kind, itemId, form.get("op") !== "unlink");
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/campanhas/${campaignId}`);
  return { ok: true, message: form.get("op") === "unlink" ? "Vínculo removido." : "Item vinculado." };
}
