import type { Metadata } from "next";
import Link from "next/link";
import { Mail, Users } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DataTable } from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/format";
import { INVITE_STATUS, USER_STATUS } from "@/components/admin/labels";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireSuperadmin } from "@/server/auth/current";
import { AGENCY_ACCESS_LABEL, GLOBAL_ROLE_LABEL, MINISTRY_ROLE_LABEL, type GlobalRole, type MinistryRole } from "@/server/auth/types";
import { listMinistries } from "@/server/services/ministries";
import { listInvitations, listUsers } from "@/server/services/users";
import { inviteUserAction, revokeInvitationAction } from "../actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Usuários e convites" };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireSuperadmin();
  const sp = await searchParams;
  const [users, invitations, ministries] = await Promise.all([
    listUsers(actor, { q: param(sp, "q"), role: param(sp, "papel"), status: param(sp, "status"), page: pageParam(sp) }),
    listInvitations(actor, { limit: 30 }),
    listMinistries(actor, { mode: "production" }),
  ]);
  const demoMinistries = await listMinistries(actor, { mode: "demo" });
  const pending = invitations.filter((i) => i.status === "pending");
  const history = invitations.filter((i) => i.status !== "pending").slice(0, 10);

  return (
    <>
      <PageHeader title="Usuários e convites" description="Acesso ao portal: convites de uso único, papéis, vínculos com ministérios e sessões."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Usuários e convites" }]} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <FilterBar period={false} search={{ name: "q", placeholder: "Nome ou e-mail" }} filters={[
            { name: "papel", label: "Tipo", options: Object.entries(GLOBAL_ROLE_LABEL).map(([value, label]) => ({ value, label })) },
            { name: "status", label: "Situação", options: [{ value: "active", label: "Ativos" }, { value: "disabled", label: "Desativados" }] },
          ]} />
          <Card>
            <DataTable caption="Usuários" rows={users.rows} rowKey={(r) => r.id}
              empty={<div className="p-4"><EmptyState icon={Users} title="Nenhum usuário encontrado" /></div>}
              mobileTitle={(r) => <Link href={`/admin/usuarios/${r.id}`} className="hover:text-brand">{r.name}<span className="block text-xs font-normal text-subtle">{r.email}</span></Link>}
              columns={[
                { key: "name", header: "Usuário", hideOnMobile: true, cell: (r) => (
                  <Link href={`/admin/usuarios/${r.id}`} className="font-medium hover:text-brand">{r.name}
                    {r.id === actor.userId ? <span className="ml-1 text-xs font-normal text-subtle">(você)</span> : null}
                    <span className="block text-xs font-normal text-subtle">{r.email}</span></Link>) },
                { key: "role", header: "Tipo", cell: (r) => (
                  <span className="text-sm">{GLOBAL_ROLE_LABEL[r.global_role]}
                    {r.global_role === "agency" && r.agency_global_access !== "none" ? <span className="block text-xs text-subtle">{AGENCY_ACCESS_LABEL[r.agency_global_access]}</span> : null}</span>) },
                { key: "memberships", header: "Ministérios", cell: (r) => r.global_role === "superadmin" ? <span className="text-xs text-subtle">Acesso total</span>
                  : r.memberships.length ? (
                    <ul className="space-y-0.5 text-xs">
                      {r.memberships.slice(0, 3).map((m) => <li key={m.id}>{m.ministry_name} <span className="text-subtle">· {MINISTRY_ROLE_LABEL[m.role as MinistryRole]}</span></li>)}
                      {r.memberships.length > 3 ? <li className="text-subtle">+{r.memberships.length - 3}</li> : null}
                    </ul>) : <span className="text-xs text-subtle">Nenhum</span> },
                { key: "status", header: "Situação", cell: (r) => <StatusBadge map={USER_STATUS} value={r.status} /> },
                { key: "login", header: "Último acesso", cell: (r) => <span className="text-xs text-muted" title={formatDateTime(r.last_login_at)}>{formatRelative(r.last_login_at)}</span> },
              ]} />
            <Pagination page={users.page} pageSize={users.pageSize} total={users.total} basePath="/admin/usuarios" params={flatParams(sp)} />
          </Card>
          <Card>
            <CardHeader title="Convites pendentes" description="Links ainda não utilizados. Revogue convites enviados por engano." />
            <CardContent>
              {pending.length ? (
                <ul className="divide-y divide-border">
                  {pending.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{i.name} <span className="font-normal text-subtle">· {i.email}</span></p>
                        <p className="text-xs text-subtle">
                          {GLOBAL_ROLE_LABEL[i.global_role as GlobalRole]}{i.ministry_name ? ` · ${i.ministry_name}` : ""}{i.ministry_role ? ` (${MINISTRY_ROLE_LABEL[i.ministry_role as MinistryRole]})` : ""}
                          {" · "}expira {formatRelative(i.expires_at)}{i.invited_by_name ? ` · por ${i.invited_by_name}` : ""}
                        </p>
                      </div>
                      <ActionButton action={revokeInvitationAction} hidden={{ id: i.id }} label="Revogar" variant="danger-ghost" confirm={`Revogar o convite de ${i.email}?`} />
                    </li>
                  ))}
                </ul>
              ) : <EmptyState compact icon={Mail} title="Nenhum convite pendente" />}
              {history.length ? (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium text-muted">Histórico recente</summary>
                  <ul className="mt-2 space-y-2">
                    {history.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 break-words">{i.email} <span className="text-xs text-subtle">· {formatDateTime(i.created_at)}</span></span>
                        <Badge tone={INVITE_STATUS[i.status]!.tone}>{INVITE_STATUS[i.status]!.label}</Badge>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </CardContent>
          </Card>
        </div>
        <Card className="order-first h-fit xl:order-none">
          <CardHeader title="Convidar usuário" description="Gera um link de uso único válido por 72 horas." />
          <CardContent>
            <InviteForm action={inviteUserAction} ministries={[...ministries, ...demoMinistries].map((m) => ({ id: m.id, name: m.name }))} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
