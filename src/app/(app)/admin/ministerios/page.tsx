import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { param, type RawSearch } from "@/lib/search";
import { requireSuperadmin } from "@/server/auth/current";
import { listMinistriesAdmin } from "@/server/services/admin";
import { archiveMinistryAction, createMinistryAction } from "../actions";
import { MinistryFields } from "./ministry-fields";

export const metadata: Metadata = { title: "Ministérios — administração" };

export default async function AdminMinistriesPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireSuperadmin();
  const sp = await searchParams;
  const rows = await listMinistriesAdmin(actor, { status: param(sp, "status"), demo: param(sp, "demo"), q: param(sp, "q") });
  const create = (
    <Dialog title="Novo ministério" description="O ministério começa sem membros; adicione-os na página do ministério." wide
      trigger={<Button><Plus /> Novo ministério</Button>}>
      <ActionForm action={createMinistryAction} submitLabel="Criar ministério" pendingLabel="Criando…">
        <MinistryFields idPrefix="new" />
      </ActionForm>
    </Dialog>
  );
  return (
    <>
      <PageHeader title="Ministérios" description="Cadastro de ministérios, inclusive arquivados e de demonstração."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Ministérios" }]} actions={create} />
      <FilterBar period={false} search={{ name: "q", placeholder: "Nome do ministério" }} filters={[
        { name: "status", label: "Situação", options: [{ value: "active", label: "Ativos" }, { value: "archived", label: "Arquivados" }] },
        { name: "demo", label: "Tipo", options: [{ value: "nao", label: "Produção" }, { value: "sim", label: "Demonstração" }] },
      ]} />
      <Card>
        <DataTable caption="Ministérios" rows={rows} rowKey={(r) => r.id}
          empty={<div className="p-4"><EmptyState icon={Building2} title="Nenhum ministério encontrado" description="Cadastre o primeiro ministério ou ajuste os filtros." /></div>}
          mobileTitle={(r) => <Link href={`/admin/ministerios/${r.id}`} className="hover:text-brand">{r.name}</Link>}
          columns={[
            { key: "name", header: "Ministério", hideOnMobile: true, cell: (r) => (
              <Link href={`/admin/ministerios/${r.id}`} className="flex items-center gap-2 font-medium hover:text-brand">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full ring-1 ring-border" style={{ backgroundColor: r.color ?? "var(--surface-sunken)" }} />
                <span className="min-w-0">{r.name}<span className="block text-xs font-normal text-subtle">/{r.slug}</span></span>
              </Link>) },
            { key: "status", header: "Situação", cell: (r) => (
              <span className="flex flex-wrap gap-1">
                {r.status === "archived" ? <Badge tone="muted">Arquivado</Badge> : <Badge tone="success" dot>Ativo</Badge>}
                {r.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}
              </span>) },
            { key: "members", header: "Membros", align: "right", cell: (r) => r.members },
            { key: "campaigns", header: "Campanhas", align: "right", cell: (r) => r.campaigns },
            { key: "assets", header: "Ativos", align: "right", cell: (r) => r.assets },
            { key: "created", header: "Criado em", cell: (r) => <span className="tabular">{formatDate(r.created_at)}</span> },
            { key: "actions", header: <span className="sr-only">Ações</span>, mobileLabel: "Ações", align: "right", cell: (r) => (
              <ActionButton action={archiveMinistryAction} variant="ghost" hidden={{ id: r.id, archived: r.status === "archived" ? "false" : "true" }}
                label={r.status === "archived" ? "Restaurar" : "Arquivar"}
                confirm={r.status === "archived" ? undefined : `Arquivar ${r.name}? Ele deixa de aparecer nos filtros e painéis.`} />) },
          ]} />
      </Card>
    </>
  );
}
