import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { ReportDocument } from "@/components/reports/report-document";
import { ActionForm, ConfirmButton } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime } from "@/lib/format";
import { REPORT_SCOPE } from "@/lib/labels";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { withUserDb } from "@/server/db";
import { buildReport, getReport, getReportVersion, reportParamsFromRow } from "@/server/services/reports";
import { deleteReportAction, publishReportAction, saveReportTextAction } from "../actions";
import { PublishButton } from "./publish-button";

export const metadata: Metadata = { title: "Relatório" };

export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const found = await getReport(actor, id);
  if (!found) notFound();
  const { report: r, access, versions } = found;
  const text = { title: r.title, objectives: r.objectives, executiveSummary: r.executive_summary, learnings: r.learnings, observations: r.observations };
  const wantsDraft = param(sp, "ver") === "rascunho" && access.canManage;
  const version = r.status === "published" && !wantsDraft ? await getReportVersion(actor, id, param(sp, "versao")) : null;
  const live = !version && access.canManage ? await withUserDb(actor.userId, (trx) => buildReport(trx, reportParamsFromRow(r))) : null;
  if (!version && !live) notFound();
  const shown = version ?? { data: live!.data, financials: live!.financials, version: null as number | null, createdAt: null as Date | null };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Relatórios", href: "/relatorios" }, { label: r.title }]}
        eyebrow={<span className="flex flex-wrap gap-2"><Badge tone="brand">{REPORT_SCOPE[r.scope_type]}</Badge>
          <Badge tone={r.status === "published" ? "success" : "neutral"}>{r.status === "published" ? "Publicado" : "Rascunho"}</Badge>
          {version ? <Badge>Versão {version.version} · {formatDateTime(version.createdAt)}</Badge> : <Badge tone="warning">Dados ao vivo (não congelados)</Badge>}</span>}
        title={r.title}
        description={`${r.ministry_name ?? "Todos os ministérios"} · ${formatDate(r.period_start)} a ${formatDate(r.period_end)}`}
        actions={<Button asChild><a href={`/api/relatorios/${id}/pdf${version ? `?versao=${encodeURIComponent(param(sp, "versao") ?? "")}` : "?versao=rascunho"}`}><Download /> Baixar PDF</a></Button>}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {!version ? (
            <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
              Revisão: os dados abaixo são calculados agora. Ao publicar, eles serão congelados em uma versão.
            </p>
          ) : null}
          <ReportDocument data={shown.data} financials={shown.financials} text={text} investmentRestricted={!shown.financials} />
        </div>
        <aside className="no-print space-y-4">
          {access.canManage ? (
            <>
              <Card>
                <CardHeader title="Publicação" />
                <CardContent className="space-y-3">
                  <PublishButton action={publishReportAction.bind(null, id)} label={r.status === "published" ? "Publicar nova versão" : "Publicar relatório"} />
                  {r.status === "published" && !wantsDraft ? <Button asChild variant="secondary" className="w-full"><a href={`/relatorios/${id}?ver=rascunho`}>Revisar dados atuais</a></Button> : null}
                </CardContent>
              </Card>
              <Card>
                <CardHeader title="Texto editorial" description="Análise e interpretação — separadas dos dados observados" />
                <CardContent>
                  <ActionForm action={saveReportTextAction.bind(null, id)} submitLabel="Salvar texto" resetOnSuccess={false}>
                    <Field label="Título" htmlFor="title"><Input id="title" name="title" defaultValue={r.title} required /></Field>
                    <Field label="Objetivos" htmlFor="objectives"><Textarea id="objectives" name="objectives" defaultValue={r.objectives ?? ""} /></Field>
                    <Field label="Resumo executivo (análise)" htmlFor="executiveSummary"><Textarea id="executiveSummary" name="executiveSummary" rows={6} defaultValue={r.executive_summary ?? ""} /></Field>
                    <Field label="Aprendizados" htmlFor="learnings"><Textarea id="learnings" name="learnings" defaultValue={r.learnings ?? ""} /></Field>
                    <Field label="Observações" htmlFor="observations"><Textarea id="observations" name="observations" defaultValue={r.observations ?? ""} /></Field>
                  </ActionForm>
                </CardContent>
              </Card>
            </>
          ) : null}
          {versions.length ? (
            <Card>
              <CardHeader title="Versões publicadas" />
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {versions.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2">
                      <a href={`/relatorios/${id}?versao=${v.id}`} className="font-medium hover:text-brand">Versão {v.version}</a>
                      <span className="text-xs text-subtle">{formatDateTime(v.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {access.canManage ? <ConfirmButton action={deleteReportAction.bind(null, id)} label="Excluir relatório" confirm="Excluir este relatório e todas as versões?" /> : null}
        </aside>
      </div>
    </>
  );
}
