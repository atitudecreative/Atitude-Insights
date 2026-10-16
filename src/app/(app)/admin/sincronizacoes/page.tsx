import type { Metadata } from "next";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { SYNC_TRIGGER } from "@/components/admin/labels";
import { ActionForm } from "@/components/ui/action-form";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DataTable } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import { SYNC_JOB_STATUS, SYNC_JOB_TYPE } from "@/lib/labels";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireGlobalRead } from "@/server/auth/current";
import { getSchedule, listSyncJobs } from "@/server/services/admin";
import { saveScheduleAction } from "../actions";
import { jobDuration, statsSummary } from "./format";

export const metadata: Metadata = { title: "Sincronizações" };

const SCHEDULE_FIELDS = [
  { name: "asanaIncrementalMinutes", label: "Asana — incremental", unit: "minutos", min: 15, max: 1440 },
  { name: "asanaFullHours", label: "Asana — completa (reconciliação)", unit: "horas", min: 1, max: 168 },
  { name: "metaAdsHours", label: "Meta Ads", unit: "horas", min: 1, max: 48 },
  { name: "metaOrganicHours", label: "Meta orgânico", unit: "horas", min: 1, max: 48 },
] as const;

export default async function SyncJobsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireGlobalRead();
  const isAdmin = actor.globalRole === "superadmin";
  const sp = await searchParams;
  const [data, schedule] = await Promise.all([
    listSyncJobs(actor, { accountId: param(sp, "conta"), status: param(sp, "status"), jobType: param(sp, "tipo"), page: pageParam(sp) }),
    getSchedule(actor),
  ]);
  const summary = ["succeeded", "partial", "failed", "queued", "running"].map((s) => ({ s, n: data.summary[s] ?? 0 }));

  return (
    <>
      <PageHeader title="Sincronizações" description="Histórico da fila de sincronização com o Asana e a Meta: resultado, duração, volume e erros."
        breadcrumbs={isAdmin ? [{ label: "Administração", href: "/admin" }, { label: "Sincronizações" }] : undefined}
        actions={isAdmin ? <Link href="/admin/integracoes" className="text-sm font-medium text-brand hover:underline">Gerenciar integrações</Link> : null} />
      <ul className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Jobs dos últimos 7 dias">
        {summary.map(({ s, n }) => (
          <li key={s} className="rounded-card border border-border bg-surface p-4 shadow-card">
            <p className="text-[13px] font-medium text-muted">{SYNC_JOB_STATUS[s]?.label} <span className="text-xs text-subtle">(7 dias)</span></p>
            <p className="tabular mt-1 text-2xl font-semibold">{formatNumber(n)}</p>
          </li>
        ))}
      </ul>
      <FilterBar period={false} filters={[
        { name: "conta", label: "Conta", options: data.accounts.map((a) => ({ value: a.id, label: a.label })), allLabel: "Todas" },
        { name: "status", label: "Status", options: Object.entries(SYNC_JOB_STATUS).map(([value, v]) => ({ value, label: v.label })) },
        { name: "tipo", label: "Tipo", options: Object.entries(SYNC_JOB_TYPE).map(([value, label]) => ({ value, label })) },
      ]} />
      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="min-w-0 xl:col-span-3">
          <DataTable caption="Jobs de sincronização" rows={data.rows} rowKey={(r) => r.id}
            empty={<div className="p-4"><EmptyState icon={RefreshCw} title="Nenhuma sincronização encontrada" description="Os jobs aparecem aqui quando contas são conectadas ou sincronizadas." /></div>}
            mobileTitle={(r) => <Link href={`/admin/sincronizacoes/${r.id}`} className="hover:text-brand">{SYNC_JOB_TYPE[r.job_type] ?? r.job_type}</Link>}
            columns={[
              { key: "type", header: "Tipo", hideOnMobile: true, cell: (r) => (
                <Link href={`/admin/sincronizacoes/${r.id}`} className="font-medium hover:text-brand">{SYNC_JOB_TYPE[r.job_type] ?? r.job_type}
                  <span className="block text-xs font-normal text-subtle">{r.account_label ?? "Conta removida"}</span></Link>) },
              { key: "account", header: "Conta", hideOnMobile: false, className: "md:hidden", cell: (r) => r.account_label ?? "—" },
              { key: "status", header: "Status", cell: (r) => <StatusBadge map={SYNC_JOB_STATUS} value={r.status} /> },
              { key: "when", header: "Criado", cell: (r) => <span className="whitespace-nowrap text-xs">{formatDateTime(r.created_at)}<span className="block text-subtle">{SYNC_TRIGGER[r.trigger] ?? r.trigger}{r.requested_by_name ? ` · ${r.requested_by_name}` : ""}</span></span> },
              { key: "duration", header: "Duração", cell: (r) => <span className="tabular text-xs">{jobDuration(r.started_at, r.finished_at)}{r.attempts > 1 ? <span className="block text-subtle">{r.attempts} tentativas</span> : null}</span> },
              { key: "stats", header: "Resultado", cell: (r) => r.error && r.status !== "succeeded"
                ? <span className="line-clamp-2 max-w-xs break-words text-xs text-danger">{r.error}</span>
                : <span className="max-w-xs text-xs text-muted">{statsSummary(r.stats)}</span> },
            ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/admin/sincronizacoes" params={flatParams(sp)} />
        </Card>
        <Card className="h-fit">
          <CardHeader title="Agenda" description="Intervalo mínimo entre sincronizações automáticas por conta." />
          <CardContent>
            {isAdmin ? (
              <ActionForm action={saveScheduleAction} submitLabel="Salvar agenda" resetOnSuccess={false}>
                {SCHEDULE_FIELDS.map((f) => (
                  <Field key={f.name} label={f.label} htmlFor={`s-${f.name}`} hint={`Em ${f.unit} (${f.min}–${f.max}).`}>
                    <Input id={`s-${f.name}`} name={f.name} type="number" inputMode="numeric" min={f.min} max={f.max} step={1} required defaultValue={schedule[f.name]} />
                  </Field>
                ))}
              </ActionForm>
            ) : (
              <dl className="space-y-2 text-sm">
                {SCHEDULE_FIELDS.map((f) => <div key={f.name} className="flex justify-between gap-2"><dt className="text-muted">{f.label}</dt><dd className="tabular">{schedule[f.name]} {f.unit}</dd></div>)}
              </dl>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
