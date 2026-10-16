import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { ActionForm } from "@/components/ui/action-form";
import { formatDate, formatRelative } from "@/lib/format";
import { REPORT_SCOPE } from "@/lib/labels";
import { addDays, todayIso } from "@/lib/period";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { hasGlobalRead } from "@/server/auth/types";
import { campaignFormOptions } from "@/server/services/campaigns";
import { getDataMode } from "@/server/services/mode";
import { filterOptions } from "@/server/services/options";
import { listReports } from "@/server/services/reports";
import { createReportAction } from "./actions";
import { ReportParamsFields } from "./report-params-form";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Relatórios" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const [reports, options, manageOptions] = await Promise.all([
    listReports(actor, { ministryId: param(sp, "ministerio") }),
    filterOptions(actor, mode),
    campaignFormOptions(actor, mode),
  ]);
  const canCreate = manageOptions.ministries.length > 0;
  const manageable = new Set(manageOptions.ministries.map((m) => m.id));
  const end = todayIso();
  const start = addDays(end, -29);
  return (
    <>
      <PageHeader title="Relatórios" description="Prestação de contas por ministério, campanha, evento, período e canal — com revisão antes da exportação." />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Gerar relatório instantâneo" description="Visualize no portal e exporte em PDF. Os dados respeitam o seu perfil de acesso." />
          <CardContent>
            <form action="/relatorios/instantaneo" method="get" className="space-y-4">
              <ReportParamsFields allowAgency={hasGlobalRead(actor)} ministries={options.ministries} campaigns={options.campaigns} events={options.events}
                defaults={{ start, end }} />
              <div className="flex justify-end"><Button type="submit"><FileText /> Visualizar relatório</Button></div>
            </form>
          </CardContent>
        </Card>
        {canCreate ? (
          <Card>
            <CardHeader title="Novo relatório editorial" description="Salve um rascunho, escreva a análise, revise os dados e publique versões." />
            <CardContent>
              <ActionForm action={createReportAction} submitLabel="Criar rascunho">
                <Field label="Título" htmlFor="title"><Input id="title" name="title" required placeholder="Ex.: Prestação de contas — março" /></Field>
                <ReportParamsFields allowAgency={actor.globalRole === "superadmin" || actor.agencyGlobalAccess === "manage"} ministries={manageOptions.ministries}
                  campaigns={options.campaigns.filter((c) => manageable.has(c.ministry_id))} events={options.events.filter((e) => manageable.has(e.ministry_id))} defaults={{ start, end, scopeType: "ministry" }} />
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
      <Card className="mt-6">
        <CardHeader title="Relatórios salvos" description={canCreate ? "Rascunhos são visíveis apenas para a gestão; versões publicadas ficam disponíveis para o ministério." : "Relatórios publicados para os seus ministérios."} />
        <DataTable caption="Relatórios" rows={reports} rowKey={(r) => r.id}
          empty={<div className="px-5 pb-5"><EmptyState icon={FileText} title="Nenhum relatório salvo" description="Use o relatório instantâneo acima ou crie um relatório editorial." /></div>}
          mobileTitle={(r) => <Link href={`/relatorios/${r.id}`} className="hover:text-brand">{r.title}</Link>}
          columns={[
            { key: "title", header: "Relatório", hideOnMobile: true, cell: (r) => <Link href={`/relatorios/${r.id}`} className="font-medium hover:text-brand">{r.title}</Link> },
            { key: "scope", header: "Tipo", cell: (r) => REPORT_SCOPE[r.scope_type] },
            { key: "ministry", header: "Ministério", cell: (r) => r.ministry_name ?? "Todos" },
            { key: "period", header: "Período", cell: (r) => `${formatDate(r.period_start)} – ${formatDate(r.period_end)}` },
            { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "published" ? "success" : "neutral"}>{r.status === "published" ? "Publicado" : "Rascunho"}</Badge> },
            { key: "updated", header: "Atualizado", cell: (r) => formatRelative(r.updated_at) },
          ]} />
      </Card>
    </>
  );
}
