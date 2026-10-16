import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, PlugZap, Users } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { ToggleForm } from "@/components/admin/toggle-form";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { formatDate, formatRelative } from "@/lib/format";
import { ASSET_TYPE } from "@/lib/labels";
import { requireSuperadmin } from "@/server/auth/current";
import { GLOBAL_ROLE_LABEL, MINISTRY_ROLE_LABEL, type GlobalRole, type MinistryRole } from "@/server/auth/types";
import { getMinistryAdmin } from "@/server/services/admin";
import { compatibleMinistryRoles, membershipCandidates } from "@/server/services/users";
import {
  addMembershipAction, archiveMinistryAction, removeAssetMappingAction, removeMembershipAction, updateMembershipAction, updateMinistryAction,
} from "../../actions";
import { MinistryFields } from "../ministry-fields";

export const metadata: Metadata = { title: "Ministério — administração" };

export default async function AdminMinistryPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireSuperadmin();
  const { id } = await params;
  const [data, candidates] = await Promise.all([getMinistryAdmin(actor, id), membershipCandidates(actor)]);
  if (!data) notFound();
  const { ministry: m, members, assets } = data;
  const path = `/admin/ministerios/${id}`;
  const memberIds = new Set(members.map((x) => x.user_id));
  const available = candidates.filter((u) => !memberIds.has(u.id) && u.status !== "disabled");

  return (
    <>
      <PageHeader title={m.name} breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Ministérios", href: "/admin/ministerios" }, { label: m.name }]}
        eyebrow={<span className="flex flex-wrap gap-1">
          {m.status === "archived" ? <Badge tone="muted">Arquivado em {formatDate(m.archived_at)}</Badge> : <Badge tone="success" dot>Ativo</Badge>}
          {m.is_demo ? <Badge tone="warning">Dados de demonstração</Badge> : null}
        </span>}
        description={`${data.counts.campaigns} campanhas · ${data.counts.events} eventos · ${data.counts.tasks} demandas · ${data.counts.deliverables} entregáveis`}
        actions={<>
          {m.status === "active" ? <Link href={`/ministerios/${m.slug}`} className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground"><ExternalLink className="size-4" /> Ver painel</Link> : null}
          <ActionButton action={archiveMinistryAction} size="md" hidden={{ id: m.id, archived: m.status === "archived" ? "false" : "true" }}
            label={m.status === "archived" ? "Restaurar" : "Arquivar"} variant={m.status === "archived" ? "secondary" : "danger-ghost"}
            confirm={m.status === "archived" ? undefined : "Arquivar este ministério? Os dados são mantidos, mas ele sai dos filtros e painéis."} />
        </>} />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Membros" description="Vínculos explícitos usuário ⇄ ministério. Superadministradores não precisam de vínculo." />
            <DataTable caption="Membros" rows={members} rowKey={(r) => r.id}
              empty={<div className="px-5 pb-5"><EmptyState compact icon={Users} title="Nenhum membro vinculado" /></div>}
              mobileTitle={(r) => <Link href={`/admin/usuarios/${r.user_id}`} className="hover:text-brand">{r.name}</Link>}
              columns={[
                { key: "name", header: "Usuário", hideOnMobile: true, cell: (r) => (
                  <Link href={`/admin/usuarios/${r.user_id}`} className="font-medium hover:text-brand">{r.name}
                    <span className="block text-xs font-normal text-subtle">{r.email} · {GLOBAL_ROLE_LABEL[r.global_role as GlobalRole]}</span></Link>) },
                { key: "role", header: "Papel", cell: (r) => (
                  <ActionButton action={updateMembershipAction.bind(null, path)} hidden={{ membershipId: r.id }} label="Salvar" variant="ghost" className="flex flex-wrap items-center gap-1 space-y-0">
                    <label className="sr-only" htmlFor={`role-${r.id}`}>Papel de {r.name}</label>
                    <Select id={`role-${r.id}`} name="role" defaultValue={r.role} className="h-8 w-auto min-w-44 text-xs">
                      {compatibleMinistryRoles(r.global_role as GlobalRole).map((role) => <option key={role} value={role}>{MINISTRY_ROLE_LABEL[role]}</option>)}
                    </Select>
                  </ActionButton>) },
                { key: "investment", header: "Investimento", cell: (r) => (
                  r.role === "agency_manager" || r.role === "agency_viewer"
                    ? <span className="text-xs text-subtle">Sempre visível (agência)</span>
                    : <ToggleForm action={updateMembershipAction.bind(null, path)} name="canViewInvestment" checked={r.can_view_investment} label="Pode ver"
                      hidden={{ membershipId: r.id, investmentField: "1" }} />) },
                { key: "status", header: "Situação", cell: (r) => r.status === "disabled" ? <Badge tone="danger">Desativado</Badge> : <Badge tone="success" dot>Ativo</Badge> },
                { key: "remove", header: <span className="sr-only">Remover</span>, mobileLabel: "Ações", align: "right", cell: (r) => (
                  <ActionButton action={removeMembershipAction.bind(null, path)} hidden={{ membershipId: r.id }} label="Remover" variant="danger-ghost"
                    confirm={`Remover ${r.name} deste ministério? O acesso é revogado imediatamente.`} />) },
              ]} />
          </Card>

          <Card>
            <CardHeader title="Ativos externos associados" description="Contas e projetos cujos itens são atribuídos a este ministério. A classificação automática só ocorre quando o ativo está associado a UM único ministério." />
            <CardContent>
              {assets.length ? (
                <ul className="divide-y divide-border">
                  {assets.map((a) => (
                    <li key={a.mapping_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{a.name}</p>
                        <p className="text-xs text-subtle">
                          {ASSET_TYPE[a.asset_type] ?? a.asset_type} · <Link className="text-brand hover:underline" href={`/admin/integracoes/${a.account_id}`}>{a.account_label}</Link>
                          {" · "}{a.sync_enabled ? `sincronizado ${formatRelative(a.last_synced_at)}` : "sincronização desativada"}
                        </p>
                        {a.mapped_ministries > 1 ? <p className="mt-1 text-xs text-warning">Associado a {a.mapped_ministries} ministérios — itens vão para a fila de revisão, salvo regras.</p> : null}
                      </div>
                      <ActionButton action={removeAssetMappingAction.bind(null, path)} hidden={{ mappingId: a.mapping_id }} label="Desassociar" variant="danger-ghost"
                        confirm="Remover a associação? Itens futuros deste ativo não serão mais atribuídos automaticamente a este ministério." />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState compact icon={PlugZap} title="Nenhum ativo associado"
                  description={<>Associe contas de anúncios, perfis e projetos em <Link href="/admin/integracoes" className="text-brand hover:underline">Integrações</Link>.</>} />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Adicionar membro" />
            <CardContent>
              {available.length ? (
                <ActionForm action={addMembershipAction.bind(null, path)} submitLabel="Adicionar" pendingLabel="Adicionando…">
                  <Field label="Usuário" htmlFor="m-user" required>
                    <Select id="m-user" name="userId" required defaultValue="">
                      <option value="" disabled>Selecione…</option>
                      {available.map((u) => <option key={u.id} value={u.id}>{u.name} — {GLOBAL_ROLE_LABEL[u.global_role as GlobalRole]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Papel" htmlFor="m-role" required hint="Agência: gestão/consulta. Ministério: liderança/operacional.">
                    <Select id="m-role" name="role" required defaultValue="">
                      <option value="" disabled>Selecione…</option>
                      {(Object.keys(MINISTRY_ROLE_LABEL) as MinistryRole[]).map((r) => <option key={r} value={r}>{MINISTRY_ROLE_LABEL[r]}</option>)}
                    </Select>
                  </Field>
                  <Checkbox name="canViewInvestment" label="Pode ver investimentos" description="Somente para liderança/operacional; a agência sempre vê." />
                  <input type="hidden" name="ministryId" value={m.id} />
                </ActionForm>
              ) : <p className="text-sm text-subtle">Todos os usuários elegíveis já estão vinculados. <Link href="/admin/usuarios" className="text-brand hover:underline">Convide um novo usuário</Link>.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Dados do ministério" />
            <CardContent>
              <ActionForm action={updateMinistryAction.bind(null, m.id)} submitLabel="Salvar alterações" pendingLabel="Salvando…" resetOnSuccess={false}>
                <MinistryFields idPrefix="edit" defaults={m} />
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
