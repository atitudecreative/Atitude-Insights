import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ExternalLink, Package, Plus } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { formatDate } from "@/lib/format";
import { DELIVERABLE_STATUS, DELIVERABLE_TYPE } from "@/lib/labels";
import { parsePeriod, todayIso } from "@/lib/period";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { listDeliverables } from "@/server/services/deliverables";
import { getDataMode } from "@/server/services/mode";
import { filterOptions } from "@/server/services/options";

export const metadata: Metadata = { title: "Entregáveis" };

export default async function DeliverablesPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const ministryId = param(sp, "ministerio");
  const period = param(sp, "periodo") ? parsePeriod({ periodo: param(sp, "periodo"), inicio: param(sp, "inicio"), fim: param(sp, "fim") }) : null;
  const [data, options] = await Promise.all([
    listDeliverables(actor, { mode, ministryId, campaignId: param(sp, "campanha"), status: param(sp, "status"), type: param(sp, "tipo"), from: period?.start, to: period?.end, page: pageParam(sp) }),
    filterOptions(actor, mode, ministryId),
  ]);
  const today = todayIso();
  return (
    <>
      <PageHeader title="Entregáveis" description="Peças e materiais produzidos pela agência, com status de aprovação e vínculo com campanhas e eventos."
        actions={isAgencyStaff(actor) ? <Button asChild><Link href="/entregaveis/novo"><Plus /> Novo entregável</Link></Button> : null} />
      <FilterBar filters={[
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "campanha", label: "Campanha", allLabel: "Todas", options: options.campaigns.map((c) => ({ value: c.id, label: c.name })) },
        { name: "status", label: "Status", options: Object.entries(DELIVERABLE_STATUS).map(([value, v]) => ({ value, label: v.label })) },
        { name: "tipo", label: "Tipo", options: Object.entries(DELIVERABLE_TYPE).map(([value, label]) => ({ value, label })) },
      ]} />
      {!period ? <p className="-mt-4 mb-4 text-xs text-subtle">Sem período selecionado: exibindo todos os entregáveis. Ao escolher um período, filtra pela data de registro.</p> : null}
      {data.rows.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Entregáveis">
          {data.rows.map((d) => {
            const overdue = d.due_date && d.due_date < today && !["approved", "delivered", "cancelled"].includes(d.status);
            return (
              <li key={d.id}>
                <Card className="flex h-full flex-col p-4 transition-colors hover:border-border-strong">
                  <div className="flex items-start justify-between gap-2">
                    <Badge tone="neutral">{DELIVERABLE_TYPE[d.type] ?? d.type}</Badge>
                    <StatusBadge map={DELIVERABLE_STATUS} value={d.status} />
                  </div>
                  <Link href={`/entregaveis/${d.id}`} className="mt-3 font-medium text-foreground hover:text-brand">{d.title}</Link>
                  <p className="mt-1 text-xs text-subtle">{d.ministry_name}{d.campaign_name ? ` · ${d.campaign_name}` : ""}{d.event_name ? ` · ${d.event_name}` : ""}</p>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-xs">
                    <span className={overdue ? "inline-flex items-center gap-1 font-medium text-danger" : "inline-flex items-center gap-1 text-muted"}>
                      <CalendarDays className="size-3.5" aria-hidden />
                      {d.delivered_at ? `Entregue ${formatDate(d.delivered_at)}` : d.due_date ? `${overdue ? "Atrasado · " : "Prazo "}${formatDate(d.due_date)}` : "Sem prazo"}
                    </span>
                    {d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">Abrir <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(nova aba)</span></a> : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : <EmptyState icon={Package} title="Nenhum entregável encontrado" description="Ajuste os filtros ou registre um novo entregável." />}
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/entregaveis" params={flatParams(sp)} />
    </>
  );
}
