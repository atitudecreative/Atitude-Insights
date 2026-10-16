"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AdminActionState } from "@/components/admin/action-button";
import { requireSuperadmin } from "@/server/auth/current";
import { saveSchedule } from "@/server/services/admin";
import { toActionError } from "@/server/services/context";
import { loadDemoData, removeDemoData } from "@/server/services/demo";
import {
  addAssetMapping, connectWithToken, deleteMappingRule, disconnectAccount, removeAssetMapping, retryJob, runSync, saveMappingRule,
  setAssetSyncEnabled, setMappingRuleActive, testConnection, updateAccountSettings, type SyncKind,
} from "@/server/services/integrations-admin";
import { createMinistry, setMinistryArchived, updateMinistry } from "@/server/services/ministries";
import { brandingSchema, saveSetting } from "@/server/services/settings";
import { zodErrors } from "@/server/services/context";
import {
  addMembership, createResetLink, inviteUser, removeMembership, revokeInvitation, revokeSessions, setUserStatus, softDeleteUser,
  updateMembership, updateUserRole,
} from "@/server/services/users";

type Prev = AdminActionState | null;
const str = (form: FormData, key: string) => String(form.get(key) ?? "");
const bool = (form: FormData, key: string) => form.get(key) === "on" || form.get(key) === "true";

// ---------------------------------------------------------------------------
// Ministérios
// ---------------------------------------------------------------------------
function ministryFromForm(form: FormData) {
  return { name: str(form, "name"), slug: str(form, "slug"), description: str(form, "description"), color: str(form, "color"), logoUrl: str(form, "logoUrl") };
}

export async function createMinistryAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  let id: string;
  try {
    id = (await createMinistry(actor, ministryFromForm(form))).id;
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/ministerios");
  redirect(`/admin/ministerios/${id}`);
}

export async function updateMinistryAction(id: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await updateMinistry(actor, id, ministryFromForm(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/ministerios");
  revalidatePath(`/admin/ministerios/${id}`);
  return { ok: true, message: "Ministério atualizado." };
}

export async function archiveMinistryAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const id = str(form, "id");
  const archived = str(form, "archived") === "true";
  try {
    await setMinistryArchived(actor, id, archived);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/ministerios");
  revalidatePath(`/admin/ministerios/${id}`);
  return { ok: true, message: archived ? "Ministério arquivado." : "Ministério restaurado." };
}

// ---------------------------------------------------------------------------
// Usuários, vínculos e convites
// ---------------------------------------------------------------------------
export async function inviteUserAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const globalRole = str(form, "globalRole");
  const ministryId = str(form, "ministryId") || null;
  try {
    const r = await inviteUser(actor, {
      email: str(form, "email"), name: str(form, "name"), globalRole,
      agencyGlobalAccess: globalRole === "agency" ? (str(form, "agencyGlobalAccess") || "none") : "none",
      ministryId: globalRole === "superadmin" ? null : ministryId,
      ministryRole: globalRole === "superadmin" || !ministryId ? null : (str(form, "ministryRole") || null),
      canViewInvestment: bool(form, "canViewInvestment"),
    });
    revalidatePath("/admin/usuarios");
    return {
      ok: true, message: "Convite criado.", link: r.link, linkLabel: "Link de convite (copie agora — ele não será exibido novamente)",
      linkHint: `Envie este link à pessoa convidada. Ele é de uso único e expira em ${r.expiresInHours} horas.`,
    };
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeInvitationAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await revokeInvitation(actor, str(form, "id"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/usuarios");
  return { ok: true, message: "Convite revogado." };
}

export async function resetLinkAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    const r = await createResetLink(actor, str(form, "userId"));
    return {
      ok: true, link: r.link, linkLabel: "Link de redefinição de senha (copie agora — ele não será exibido novamente)",
      linkHint: `Uso único; expira em ${r.expiresInHours} horas. Ao redefinir a senha, as sessões do usuário são encerradas.`,
    };
  } catch (error) {
    return toActionError(error);
  }
}

export async function setUserStatusAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const userId = str(form, "userId");
  const status = str(form, "status") === "disabled" ? "disabled" : "active";
  try {
    await setUserStatus(actor, userId, status);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/usuarios");
  revalidatePath(`/admin/usuarios/${userId}`);
  return { ok: true, message: status === "disabled" ? "Usuário desativado e sessões encerradas." : "Usuário reativado." };
}

export async function updateUserRoleAction(userId: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    const r = await updateUserRole(actor, userId, { globalRole: str(form, "globalRole"), agencyGlobalAccess: str(form, "agencyGlobalAccess") || "none" });
    revalidatePath("/admin/usuarios");
    revalidatePath(`/admin/usuarios/${userId}`);
    return { ok: true, message: r.removedMemberships ? `Papel atualizado. ${r.removedMemberships} vínculo(s) incompatível(is) removido(s).` : "Papel atualizado." };
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeSessionsAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const userId = str(form, "userId");
  try {
    const n = await revokeSessions(actor, userId);
    revalidatePath(`/admin/usuarios/${userId}`);
    return { ok: true, message: `${n} sessão(ões) encerrada(s).` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteUserAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await softDeleteUser(actor, str(form, "userId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/usuarios");
  redirect("/admin/usuarios");
}

/** Usado tanto na página do usuário quanto na do ministério (`path` = página a revalidar). */
export async function addMembershipAction(path: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await addMembership(actor, { userId: str(form, "userId"), ministryId: str(form, "ministryId"), role: str(form, "role"), canViewInvestment: bool(form, "canViewInvestment") });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  revalidatePath("/admin/usuarios");
  return { ok: true, message: "Vínculo adicionado." };
}

export async function updateMembershipAction(path: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    const patch: { role?: string; canViewInvestment?: boolean } = {};
    if (form.has("role")) patch.role = str(form, "role");
    if (form.has("investmentField")) patch.canViewInvestment = bool(form, "canViewInvestment");
    await updateMembership(actor, str(form, "membershipId"), patch);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  return { ok: true, message: "Vínculo atualizado." };
}

export async function removeMembershipAction(path: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await removeMembership(actor, str(form, "membershipId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  revalidatePath("/admin/usuarios");
  return { ok: true, message: "Vínculo removido." };
}

// ---------------------------------------------------------------------------
// Integrações
// ---------------------------------------------------------------------------
export async function connectTokenAction(provider: "asana" | "meta", _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  let id: string;
  try {
    id = await connectWithToken(actor, provider, { label: str(form, "label"), token: str(form, "token") });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/integracoes");
  redirect(`/admin/integracoes/${id}?ok=conectada`);
}

export async function testConnectionAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const id = str(form, "accountId");
  try {
    const r = await testConnection(actor, id);
    revalidatePath("/admin/integracoes");
    revalidatePath(`/admin/integracoes/${id}`);
    return { ok: r.ok, message: r.message };
  } catch (error) {
    return toActionError(error);
  }
}

const SYNC_LABEL: Record<SyncKind, string> = { sync: "Sincronização", discover: "Descoberta de ativos", reclassify: "Reclassificação" };

export async function runSyncAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const id = str(form, "accountId");
  const kind = (["sync", "discover", "reclassify"] as const).find((k) => k === str(form, "kind")) ?? "sync";
  try {
    const r = await runSync(actor, id, kind, { inline: true });
    revalidatePath("/admin/integracoes");
    revalidatePath(`/admin/integracoes/${id}`);
    revalidatePath("/admin/sincronizacoes");
    const done = r.results.filter((x) => r.jobs.some((j) => j.id === x.jobId));
    const failed = done.filter((x) => x.status === "failed" || x.status === "retry").length;
    const pending = r.jobs.length - done.filter((x) => x.status !== "continue").length;
    const parts = [`${SYNC_LABEL[kind]}: ${r.jobs.length} job(s) na fila`];
    if (done.length) parts.push(`${done.length - failed} concluído(s)${failed ? `, ${failed} com falha` : ""}`);
    if (pending > 0) parts.push(`${pending} continuará(ão) em segundo plano`);
    return { ok: failed === 0, message: `${parts.join(" · ")}. Detalhes em Sincronizações.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function disconnectAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const id = str(form, "accountId");
  try {
    await disconnectAccount(actor, id);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/integracoes");
  revalidatePath(`/admin/integracoes/${id}`);
  return { ok: true, message: "Conta desconectada e credencial removida." };
}

export async function updateAccountAction(id: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await updateAccountSettings(actor, id, { label: str(form, "label"), syncEnabled: bool(form, "syncEnabled") });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/admin/integracoes/${id}`);
  revalidatePath("/admin/integracoes");
  return { ok: true, message: "Conta atualizada." };
}

export async function assetSyncAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await setAssetSyncEnabled(actor, str(form, "assetId"), bool(form, "enabled"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/admin/integracoes/${str(form, "accountId")}`);
  return { ok: true };
}

export async function addAssetMappingAction(path: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await addAssetMapping(actor, str(form, "assetId"), str(form, "ministryId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  return { ok: true, message: "Ativo associado." };
}

export async function removeAssetMappingAction(path: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await removeAssetMapping(actor, str(form, "mappingId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(path);
  return { ok: true, message: "Associação removida." };
}

export async function saveMappingRuleAction(accountId: string, ruleId: string | null, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await saveMappingRule(actor, ruleId, {
      provider: str(form, "provider"), ruleType: str(form, "ruleType"), externalAssetId: str(form, "externalAssetId"),
      matchField: str(form, "matchField"), matchValue: str(form, "matchValue"), ministryId: str(form, "ministryId"),
      campaignId: str(form, "campaignId"), eventId: str(form, "eventId"), priority: str(form, "priority") || "100", active: bool(form, "active"),
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/admin/integracoes/${accountId}`);
  return { ok: true, message: "Regra salva. Use “Reclassificar” para aplicá-la aos itens já sincronizados." };
}

export async function toggleMappingRuleAction(accountId: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await setMappingRuleActive(actor, str(form, "ruleId"), bool(form, "enabled"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/admin/integracoes/${accountId}`);
  return { ok: true };
}

export async function deleteMappingRuleAction(accountId: string, _: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await deleteMappingRule(actor, str(form, "ruleId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/admin/integracoes/${accountId}`);
  return { ok: true, message: "Regra removida." };
}

// ---------------------------------------------------------------------------
// Sincronizações
// ---------------------------------------------------------------------------
export async function retryJobAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  let id: string;
  try {
    id = await retryJob(actor, str(form, "jobId"));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/sincronizacoes");
  redirect(`/admin/sincronizacoes/${id}`);
}

export async function saveScheduleAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    await saveSchedule(actor, Object.fromEntries(form));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/sincronizacoes");
  return { ok: true, message: "Agenda de sincronização salva." };
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
export async function saveBrandingAction(_: Prev, form: FormData): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  const parsed = brandingSchema.safeParse({
    name: str(form, "name"), organization: str(form, "organization"), primaryColor: str(form, "primaryColor"), logoUrl: str(form, "logoUrl"),
  });
  if (!parsed.success) return { ok: false, message: "Verifique os campos.", errors: zodErrors(parsed.error.issues) };
  try {
    await saveSetting(actor, "branding", parsed.data);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Identidade visual salva." };
}

export async function loadDemoAction(): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    const s = await loadDemoData(actor);
    revalidatePath("/", "layout");
    return { ok: true, message: `Dados de demonstração carregados: ${s.ministries} ministérios, ${s.campaigns} campanhas, ${s.events} eventos, ${s.tasks} demandas, ${s.posts} publicações e ${s.observations} métricas. Ative o “Modo demonstração” no menu para visualizá-los.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function removeDemoAction(): Promise<AdminActionState> {
  const actor = await requireSuperadmin();
  try {
    const r = await removeDemoData(actor);
    revalidatePath("/", "layout");
    return { ok: true, message: r.ministries ? `Dados de demonstração removidos (${r.ministries} ministérios).` : "Não havia dados de demonstração." };
  } catch (error) {
    return toActionError(error);
  }
}
