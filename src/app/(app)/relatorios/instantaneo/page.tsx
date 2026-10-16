import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { ReportDocument } from "@/components/reports/report-document";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { reportParamsFromSearch } from "@/lib/report-params";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { ServiceError } from "@/server/services/context";
import { liveReport } from "@/server/services/reports";

export const metadata: Metadata = { title: "Relatório instantâneo" };

export default async function LiveReportPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  // Aceita tanto os nomes do formulário (scopeType/start/end) quanto os da URL curta.
  const get = (k: string) => param(sp, k) ?? param(sp, ({ escopo: "scopeType", ministerio: "ministryId", campanha: "campaignId", evento: "eventId", inicio: "start", fim: "end", canal: "channel" } as Record<string, string>)[k] ?? "");
  const params = reportParamsFromSearch(get);
  let report;
  try {
    report = await liveReport(actor, params);
  } catch (error) {
    if (error instanceof ServiceError) notFound();
    throw error;
  }
  const { data, financials } = report;
  const title = `Relatório — ${data.subject.campaignName ?? data.subject.eventName ?? data.subject.ministryName ?? "Consolidado da agência"}`;
  const qs = new URLSearchParams({ escopo: data.params.scopeType, inicio: data.params.start, fim: data.params.end, titulo: title });
  if (data.params.ministryId) qs.set("ministerio", data.params.ministryId);
  if (data.params.campaignId) qs.set("campanha", data.params.campaignId);
  if (data.params.eventId) qs.set("evento", data.params.eventId);
  if (data.params.channel) qs.set("canal", data.params.channel);
  return (
    <>
      <div className="no-print">
        <PageHeader breadcrumbs={[{ label: "Relatórios", href: "/relatorios" }, { label: "Instantâneo" }]} title="Pré-visualização do relatório"
          description="Revise os dados antes de exportar. O PDF contém exatamente as informações que você pode visualizar."
          actions={<>
            <Button asChild variant="secondary"><Link href="/relatorios">Alterar parâmetros</Link></Button>
            <Button asChild><a href={`/api/relatorios/pdf?${qs.toString()}`}><Download /> Baixar PDF</a></Button>
          </>} />
      </div>
      <ReportDocument data={data} financials={financials} text={{ title }} investmentRestricted={!financials} />
      <p className="no-print mt-4 flex items-center justify-center gap-2 text-xs text-subtle"><Printer className="size-3.5" aria-hidden /> Também é possível imprimir esta página pelo navegador.</p>
    </>
  );
}
