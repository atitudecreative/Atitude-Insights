import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DataTable } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { CAMPAIGN_STATUS } from "@/lib/labels";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { listCampaigns } from "@/server/services/campaigns";
import { getDataMode } from "@/server/services/mode";
import { filterOptions } from "@/server/services/options";

export const metadata: Metadata = { title: "Campanhas" };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const ministryId = param(sp, "ministerio");
  const [data, options] = await Promise.all([
    listCampaigns(actor, { mode, ministryId, status: param(sp, "status"), eventId: param(sp, "evento"), channelKey: param(sp, "canal"), q: param(sp, "q"), page: pageParam(sp) }),
    filterOptions(actor, mode, ministryId),
  ]);
  return (
    <>
      <PageHeader title="Campanhas" description="Campanhas de comunicação: o que foi planejado, produzido e veiculado para cada ministério."
        actions={isAgencyStaff(actor) ? <Button asChild><Link href="/campanhas/nova"><Plus /> Nova campanha</Link></Button> : null} />
      <FilterBar period={false} search={{ name: "q", placeholder: "Nome da campanha" }} filters={[
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "status", label: "Status", options: Object.entries(CAMPAIGN_STATUS).map(([value, v]) => ({ value, label: v.label })) },
        { name: "evento", label: "Evento", options: options.events.map((e) => ({ value: e.id, label: e.name })) },
        { name: "canal", label: "Canal", options: [{ value: "instagram", label: "Instagram" }, { value: "facebook", label: "Facebook" }, { value: "meta_ads", label: "Meta Ads" }, { value: "email", label: "E-mail" }, { value: "landing_page", label: "Landing page" }, { value: "whatsapp", label: "WhatsApp" }] },
      ]} />
      <Card>
        <DataTable caption="Campanhas" rows={data.rows} rowKey={(r) => r.id}
          empty={<div className="p-4"><EmptyState icon={Megaphone} title="Nenhuma campanha encontrada" description="Ajuste os filtros ou cadastre uma nova campanha." /></div>}
          mobileTitle={(r) => <Link href={`/campanhas/${r.id}`} className="hover:text-brand">{r.name}</Link>}
          columns={[
            { key: "name", header: "Campanha", hideOnMobile: true, cell: (r) => (
              <Link href={`/campanhas/${r.id}`} className="font-medium hover:text-brand">{r.name}
                {r.objective ? <span className="mt-0.5 block max-w-md truncate text-xs font-normal text-subtle">{r.objective}</span> : null}</Link>) },
            { key: "ministry", header: "Ministério", cell: (r) => r.ministry_name },
            { key: "status", header: "Status", cell: (r) => <StatusBadge map={CAMPAIGN_STATUS} value={r.status} /> },
            { key: "period", header: "Período", cell: (r) => <span className="tabular whitespace-nowrap">{formatDate(r.start_date)} – {formatDate(r.end_date)}</span> },
            { key: "channels", header: "Canais", cell: (r) => r.channels.length ? r.channels.map((c) => c.name.split(" (")[0]).join(", ") : <span className="text-subtle">—</span> },
            { key: "tasks", header: "Demandas", align: "right", cell: (r) => `${r.tasks_done}/${r.tasks_total}` },
            { key: "deliverables", header: "Entregáveis", align: "right", cell: (r) => r.deliverables_total },
          ]} />
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/campanhas" params={flatParams(sp)} />
      </Card>
    </>
  );
}
