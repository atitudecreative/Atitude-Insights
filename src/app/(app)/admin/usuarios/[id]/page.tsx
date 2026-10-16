import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2 } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { USER_STATUS } from "@/components/admin/labels";
import { ToggleForm } from "@/components/admin/toggle-form";
import { ActionForm } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { ActivityFeed } from "@/components/ui/timeline";
import { formatDateTime, formatRelative } from "@/lib/format";
import { requireSuperadmin } from "@/server/auth/current";
import { AGENCY_ACCESS_LABEL, GLOBAL_ROLE_LABEL, MINISTRY_ROLE_LABEL } from "@/server/auth/types";
import { listMinistries } from "@/server/services/ministries";
import { compatibleMinistryRoles, getUser } from "@/server/services/users";
import {
  addMembershipAction, deleteUserAction, removeMembershipAction, resetLinkAction, revokeSessionsAction, setUserStatusAction, updateMembershipAction,
  updateUserRoleAction,
} from "../../actions";

export const metadata: Metadata = { title: "Usuário — administração" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireSuperadmin();
  const { id } = await params;
  const data = await getUser(actor, id);
  if (!data) notFound();
  const { user: u, memberships } = data;
  const self = u.id === actor.userId;
  const path = `/admin/usuarios/${id}`;
  const roles = compatibleMinistryRoles(u.global_role);
  const ministries = (await listMinistries(actor, {})).filter((m) => !memberships.some((x) => x.ministry_id === m.id));

  return (
    <>
      <PageHeader title={u.name} description={u.email}
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Usuários", href: "/admin/usuarios" }, { label: u.name }]}
        eyebrow={<span className="flex flex-wrap gap-1"><StatusBadge map={USER_STATUS} value={u.status} /><Badge tone="brand">{GLOBAL_ROLE_LABEL[u.global_role]}</Badge>{self ? <Badge>Você</Badge> : null}</span>} />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Vínculos com ministérios" description={u.global_role === "superadmin" ? "Superadministradores acessam todos os ministérios sem vínculo." : "O acesso a dados de um ministério exige vínculo explícito (ou visão global da agência)."} />
            <CardContent>
              {memberships.length ? (
                <ul className="divide-y divide-border">
                  {memberships.map((m) => (
                    <li key={m.id} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <Link href={`/admin/ministerios/${m.ministry_id}`} className="text-sm font-medium hover:text-brand">{m.ministry_name}</Link>
                        <span className="ml-2 inline-flex gap-1">
                          {m.is_demo ? <Badge tone="warning">Demo</Badge> : null}
                          {m.ministry_status === "archived" ? <Badge tone="muted">Arquivado</Badge> : null}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <ActionButton action={updateMembershipAction.bind(null, path)} hidden={{ membershipId: m.id }} label="Salvar" variant="ghost" className="flex flex-wrap items-center gap-1 space-y-0">
                          <label className="sr-only" htmlFor={`r-${m.id}`}>Papel em {m.ministry_name}</label>
                          <Select id={`r-${m.id}`} name="role" defaultValue={m.role} className="h-8 w-auto min-w-44 text-xs">
                            {roles.map((r) => <option key={r} value={r}>{MINISTRY_ROLE_LABEL[r]}</option>)}
                          </Select>
                        </ActionButton>
                        {m.role === "leader" || m.role === "operational" ? (
                          <ToggleForm action={updateMembershipAction.bind(null, path)} name="canViewInvestment" checked={m.can_view_investment} label="Vê investimentos"
                            hidden={{ membershipId: m.id, investmentField: "1" }} />
                        ) : <span className="text-xs text-subtle">Vê investimentos (agência)</span>}
                        <ActionButton action={removeMembershipAction.bind(null, path)} hidden={{ membershipId: m.id }} label="Remover" variant="danger-ghost"
                          confirm={`Remover o vínculo com ${m.ministry_name}? O acesso é revogado imediatamente.`} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState compact icon={Building2} title="Nenhum vínculo" />}
              {roles.length && ministries.length ? (
                <div className="mt-4 border-t border-border pt-4">
                  <p className="mb-2 text-sm font-medium">Adicionar vínculo</p>
                  <ActionForm action={addMembershipAction.bind(null, path)} submitLabel="Adicionar" inline>
                    <input type="hidden" name="userId" value={u.id} />
                    <Field label="Ministério" htmlFor="add-ministry" className="min-w-0 flex-1 sm:min-w-48">
                      <Select id="add-ministry" name="ministryId" required defaultValue="">
                        <option value="" disabled>Selecione…</option>
                        {ministries.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Papel" htmlFor="add-role" className="min-w-0 flex-1 sm:min-w-44">
                      <Select id="add-role" name="role" defaultValue={roles[0]}>
                        {roles.map((r) => <option key={r} value={r}>{MINISTRY_ROLE_LABEL[r]}</option>)}
                      </Select>
                    </Field>
                    {u.global_role === "ministry" ? <Checkbox name="canViewInvestment" label="Vê investimentos" className="mb-1.5" /> : null}
                  </ActionForm>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Atividade recente" description="Ações realizadas por este usuário ou sobre ele" />
            <CardContent>
              {data.activity.length ? (
                <ActivityFeed items={data.activity.map((a) => ({
                  id: String(a.id), title: a.summary ?? `${a.entity_type} · ${a.action}`,
                  meta: <><span className="font-mono">{a.action}</span> · {formatDateTime(a.created_at)}</>,
                }))} />
              ) : <p className="text-sm text-subtle">Nenhuma atividade registrada.</p>}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Acesso" />
            <CardContent className="space-y-3 text-sm">
              <dl className="grid grid-cols-2 gap-3">
                <div><dt className="text-xs text-subtle">Último login</dt><dd title={formatDateTime(u.last_login_at)}>{formatRelative(u.last_login_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Sessões ativas</dt><dd className="tabular">{data.activeSessions}</dd></div>
                <div><dt className="text-xs text-subtle">Criado em</dt><dd>{formatDateTime(u.created_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Última atividade</dt><dd>{formatRelative(data.lastSeenAt)}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {!self ? (
                  <ActionButton action={setUserStatusAction} hidden={{ userId: u.id, status: u.status === "disabled" ? "active" : "disabled" }}
                    label={u.status === "disabled" ? "Reativar usuário" : "Desativar usuário"} variant={u.status === "disabled" ? "secondary" : "danger-ghost"}
                    confirm={u.status === "disabled" ? undefined : `Desativar ${u.name}? Todas as sessões serão encerradas imediatamente.`} />
                ) : null}
                <ActionButton action={revokeSessionsAction} hidden={{ userId: u.id }} label={self ? "Encerrar minhas outras sessões" : "Encerrar sessões"}
                  confirm="Encerrar as sessões ativas? O usuário precisará entrar novamente." />
              </div>
              {u.status !== "disabled" ? (
                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-xs text-subtle">Gera um link de uso único (24 h) para o usuário definir uma nova senha.</p>
                  <ActionButton action={resetLinkAction} hidden={{ userId: u.id }} label="Gerar link de redefinição de senha" />
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Papel global" description={self ? "Você não pode alterar o seu próprio papel." : "Vínculos incompatíveis com o novo papel são removidos automaticamente."} />
            <CardContent>
              {!self ? (
                <ActionForm action={updateUserRoleAction.bind(null, u.id)} submitLabel="Salvar papel" resetOnSuccess={false}>
                  <Field label="Tipo de usuário" htmlFor="role">
                    <Select id="role" name="globalRole" defaultValue={u.global_role}>
                      {Object.entries(GLOBAL_ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  </Field>
                  <Field label="Acesso global (somente agência)" htmlFor="access" hint="Ignorado para outros tipos de usuário.">
                    <Select id="access" name="agencyGlobalAccess" defaultValue={u.agency_global_access}>
                      {Object.entries(AGENCY_ACCESS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  </Field>
                </ActionForm>
              ) : <p className="text-sm">{GLOBAL_ROLE_LABEL[u.global_role]}</p>}
            </CardContent>
          </Card>
          {!self ? (
            <Card className="border-danger/30">
              <CardHeader title="Excluir usuário" description="Exclusão lógica: o usuário é desativado, perde os vínculos e as sessões são encerradas. O histórico de auditoria é mantido." />
              <CardContent>
                <ActionButton action={deleteUserAction} hidden={{ userId: u.id }} label="Excluir usuário" variant="danger"
                  confirm={`Excluir ${u.name}? Esta ação não pode ser desfeita pelo portal.`} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
