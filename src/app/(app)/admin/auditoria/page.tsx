import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DataTable } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireSuperadmin } from "@/server/auth/current";
import { listActivity } from "@/server/services/admin";

export const metadata: Metadata = { title: "Auditoria" };

function changesPreview(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || !Object.keys(changes).length) return null;
  const text = JSON.stringify(changes);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireSuperadmin();
  const sp = await searchParams;
  const data = await listActivity(actor, {
    ministryId: param(sp, "ministerio"), action: param(sp, "acao"), entityType: param(sp, "entidade"), visibility: param(sp, "visibilidade"), page: pageParam(sp),
  });
  return (
    <>
      <PageHeader title="Auditoria" description="Registro permanente (somente inclusão) de ações de usuários, acessos e operações de sistema."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Auditoria" }]} />
      <FilterBar period={false} filters={[
        { name: "ministerio", label: "Ministério", options: data.options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "acao", label: "Ação", options: data.options.actions.map((a) => ({ value: a, label: a })), allLabel: "Todas" },
        { name: "entidade", label: "Entidade", options: data.options.entityTypes.map((e) => ({ value: e, label: e })), allLabel: "Todas" },
        { name: "visibilidade", label: "Visibilidade", options: [{ value: "admin", label: "Administrativa" }, { value: "ministry", label: "Histórico do ministério" }] },
      ]} />
      <Card>
        <DataTable caption="Registros de auditoria" rows={data.rows} rowKey={(r) => r.id}
          empty={<div className="p-4"><EmptyState icon={ScrollText} title="Nenhum registro encontrado" /></div>}
          mobileTitle={(r) => <span className="font-mono text-sm">{r.action}</span>}
          columns={[
            { key: "when", header: "Quando", cell: (r) => <span className="whitespace-nowrap text-xs tabular">{formatDateTime(r.created_at)}</span> },
            { key: "actor", header: "Autor", cell: (r) => r.actor_name ? <span className="text-sm">{r.actor_name}<span className="block break-all text-xs text-subtle">{r.actor_email}</span></span> : <span className="text-xs text-subtle">Sistema</span> },
            { key: "action", header: "Ação", hideOnMobile: true, cell: (r) => (
              <span className="flex flex-wrap items-center gap-1"><span className="font-mono text-xs">{r.action}</span>{r.visibility === "admin" ? <Badge tone="brand">admin</Badge> : null}</span>) },
            { key: "entity", header: "Entidade", cell: (r) => <span className="text-xs">{r.entity_type}{r.entity_id ? <span className="block max-w-[14rem] truncate font-mono text-subtle" title={r.entity_id}>{r.entity_id}</span> : null}</span> },
            { key: "summary", header: "Resumo", cell: (r) => {
              const preview = changesPreview(r.changes);
              return (
                <span className="block max-w-md text-sm">
                  {r.summary ?? <span className="text-subtle">—</span>}
                  {r.ministry_name ? <span className="block text-xs text-subtle">{r.ministry_name}</span> : null}
                  {preview ? <span className="block break-all font-mono text-[11px] text-subtle">{preview}</span> : null}
                </span>
              );
            } },
            { key: "ip", header: "IP", cell: (r) => <span className="font-mono text-xs text-subtle">{r.ip ?? "—"}</span> },
          ]} />
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/admin/auditoria" params={flatParams(sp)} />
      </Card>
    </>
  );
}
