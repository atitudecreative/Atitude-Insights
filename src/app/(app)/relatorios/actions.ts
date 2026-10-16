"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/current";
import { toActionError, type ActionState } from "@/server/services/context";
import { createReport, deleteReport, publishReport, updateReportText } from "@/server/services/reports";

export async function createReportAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id: string;
  try {
    id = await createReport(actor, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/relatorios");
  redirect(`/relatorios/${id}`);
}

export async function saveReportTextAction(id: string, _prev: ActionState | null, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    await updateReportText(actor, id, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/relatorios/${id}`);
  return { ok: true, message: "Texto salvo. Revise os dados e publique quando estiver pronto." };
}

export async function publishReportAction(id: string, _prev: ActionState | null): Promise<ActionState> {
  const actor = await requireActor();
  let version: number;
  try {
    version = await publishReport(actor, id);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/relatorios/${id}`);
  return { ok: true, message: `Versão ${version} publicada. Os dados foram congelados nesta versão.` };
}

export async function deleteReportAction(id: string): Promise<void> {
  const actor = await requireActor();
  await deleteReport(actor, id);
  revalidatePath("/relatorios");
  redirect("/relatorios");
}
