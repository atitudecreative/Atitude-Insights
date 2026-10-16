import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/admin/action-button";
import { LOG_LEVEL, SYNC_TRIGGER } from "@/components/admin/labels";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime, formatNumber } from "@/lib/format";
import { INTEGRATION_STATUS, SYNC_JOB_STATUS, SYNC_JOB_TYPE } from "@/lib/labels";
import { requireGlobalRead } from "@/server/auth/current";
import { getSyncJob } from "@/server/services/admin";
import { retryJobAction } from "../../actions";
import { jobDuration } from "../format";

export const metadata: Metadata = { title: "Sincronização" };

export default async function SyncJobPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireGlobalRead();
  const isAdmin = actor.globalRole === "superadmin";
  const { id } = await params;
  const data = await getSyncJob(actor, id);
  if (!data) notFound();
  const { job: j, logs } = data;
  const stats = Object.entries(j.stats).filter(([, v]) => typeof v === "number");
  const canRetry = isAdmin && (j.status === "failed" || j.status === "cancelled" || j.status === "partial") && j.account_status !== "disconnected" && !j.account_is_demo;

  return (
    <>
      <PageHeader title={SYNC_JOB_TYPE[j.job_type] ?? j.job_type}
        breadcrumbs={[...(isAdmin ? [{ label: "Administração", href: "/admin" }] : []), { label: "Sincronizações", href: "/admin/sincronizacoes" }, { label: "Job" }]}
        eyebrow={<StatusBadge map={SYNC_JOB_STATUS} value={j.status} />}
        description={<>{isAdmin && j.connected_account_id ? <Link href={`/admin/integracoes/${j.connected_account_id}`} className="text-brand hover:underline">{j.account_label}</Link> : (j.account_label ?? "Conta removida")} · {SYNC_TRIGGER[j.trigger] ?? j.trigger}{j.requested_by_name ? ` por ${j.requested_by_name}` : ""}</>}
        actions={canRetry ? <ActionButton action={retryJobAction} hidden={{ jobId: j.id }} label="Reexecutar" size="md" variant="primary" pendingLabel="Enfileirando…" /> : null} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          {j.error ? (
            <Card className="border-danger/30">
              <CardHeader title="Erro" />
              <CardContent><p className="whitespace-pre-wrap break-words font-mono text-xs text-danger">{j.error}</p></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Registros" description={isAdmin ? `${logs.length} registro(s), em ordem cronológica` : undefined} />
            <CardContent>
              {!isAdmin ? <p className="text-sm text-subtle">Os registros detalhados são visíveis apenas para superadministradores.</p>
                : logs.length ? (
                  <ol className="space-y-2">
                    {logs.map((l) => (
                      <li key={l.id} className="rounded-lg border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <StatusBadge map={LOG_LEVEL} value={l.level} />
                          <span className="text-subtle">{formatDateTime(l.created_at)}</span>
                        </div>
                        <p className="mt-1 break-words text-sm">{l.message}</p>
                        {l.context && Object.keys(l.context as object).length ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-subtle">Contexto</summary>
                            <pre className="mt-1 max-h-60 overflow-auto rounded bg-surface-muted p-2 text-[11px] leading-relaxed">{JSON.stringify(l.context, null, 2)}</pre>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-sm text-subtle">Nenhum registro para este job.</p>}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Execução" />
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-subtle">Criado</dt><dd>{formatDateTime(j.created_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Executar após</dt><dd>{formatDateTime(j.run_after)}</dd></div>
                <div><dt className="text-xs text-subtle">Início</dt><dd>{formatDateTime(j.started_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Fim</dt><dd>{formatDateTime(j.finished_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Duração</dt><dd className="tabular">{jobDuration(j.started_at, j.finished_at)}</dd></div>
                <div><dt className="text-xs text-subtle">Tentativas</dt><dd className="tabular">{j.attempts} de {j.max_attempts}</dd></div>
                <div className="col-span-2"><dt className="text-xs text-subtle">Conta</dt><dd className="flex flex-wrap items-center gap-2">{j.account_label ?? "—"} {j.account_status ? <StatusBadge map={INTEGRATION_STATUS} value={j.account_status} /> : null}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Estatísticas" />
            <CardContent>
              {stats.length ? (
                <dl className="space-y-1.5 text-sm">
                  {stats.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k.replace(/_/g, " ")}</dt><dd className="tabular">{formatNumber(v)}</dd></div>)}
                </dl>
              ) : <p className="text-sm text-subtle">Sem estatísticas.</p>}
              {Object.keys(j.progress as object ?? {}).length ? <Badge tone="info" className="mt-3">Progresso salvo (job retomável)</Badge> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
