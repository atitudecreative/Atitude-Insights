import type { Metadata } from "next";
import { Download, ExternalLink, Link2, ListChecks, Plus, RefreshCw } from "lucide-react";
import { ActionDialog } from "@/components/ops/action-dialog";
import { ScopedSelects } from "@/components/ops/scoped-selects";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { Field, Input, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SubmitButton } from "@/components/ui/submit-button";
import { DataTable } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { TASK_STATUS, taskStatus } from "@/lib/labels";
import { todayIso } from "@/lib/period";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { getDataMode } from "@/server/services/mode";
import { filterOptions } from "@/server/services/options";
import { listTasks, operationsFormOptions, taskFiltersFromParams } from "@/server/services/tasks";
import { createTaskAction, linkTaskAction, setTaskCompletedAction } from "./actions";

export const metadata: Metadata = { title: "Demandas" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const ministryId = param(sp, "ministerio");
  const filters = taskFiltersFromParams((k) => param(sp, k), mode);
  const [data, options, manage] = await Promise.all([
    listTasks(actor, { ...filters, page: pageParam(sp) }),
    filterOptions(actor, mode, ministryId),
    operationsFormOptions(actor, mode),
  ]);
  const manageable = new Set(manage.ministries.map((m) => m.id));
  const today = todayIso();
  const exportQuery = new URLSearchParams(Object.entries(flatParams(sp)).filter(([k, v]) => v && k !== "pagina") as Array<[string, string]>).toString();

  const createDialog = manage.ministries.length ? (
    <ActionDialog title="Nova demanda manual" description="Para trabalhos fora do Asana. O status é controlado no portal." submitLabel="Cadastrar demanda" action={createTaskAction} wide
      trigger={<Button><Plus /> Nova demanda</Button>}>
      <ScopedSelects idPrefix="nt" ministries={manage.ministries} campaigns={manage.campaigns} events={manage.events}
        defaults={{ ministryId: manage.ministries.some((m) => m.id === ministryId) ? ministryId : manage.ministries.length === 1 ? manage.ministries[0]!.id : null }} />
      <Field label="Demanda" htmlFor="nt-name" required><Input id="nt-name" name="name" required minLength={2} maxLength={300} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Responsável" htmlFor="nt-assignee"><Input id="nt-assignee" name="assigneeName" maxLength={120} /></Field>
        <Field label="Prazo" htmlFor="nt-due"><Input id="nt-due" name="dueOn" type="date" /></Field>
      </div>
      <Field label="Observações" htmlFor="nt-notes"><Textarea id="nt-notes" name="notes" rows={3} /></Field>
    </ActionDialog>
  ) : null;

  return (
    <>
      <PageHeader title="Demandas" description="Trabalhos da agência sincronizados do Asana ou cadastrados manualmente, por ministério, campanha e evento."
        actions={<>
          <Button asChild variant="secondary"><a href={`/api/exportar/demandas${exportQuery ? `?${exportQuery}` : ""}`}><Download /> Exportar CSV</a></Button>
          {createDialog}
        </>} />
      <FilterBar search={{ name: "q", placeholder: "Nome da demanda" }} filters={[
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "campanha", label: "Campanha", allLabel: "Todas", options: options.campaigns.map((c) => ({ value: c.id, label: c.name })) },
        { name: "evento", label: "Evento", options: options.events.map((e) => ({ value: e.id, label: e.name })) },
        { name: "status", label: "Status", options: [{ value: "open", label: "Em andamento" }, { value: "overdue", label: "Atrasadas" }, { value: "completed", label: "Concluídas" }] },
        { name: "origem", label: "Origem", allLabel: "Todas", options: [{ value: "asana", label: "Asana" }, { value: "manual", label: "Manual" }] },
      ]} />
      {!filters.from ? <p className="-mt-4 mb-4 text-xs text-subtle">Sem período selecionado: exibindo todas as demandas. Ao escolher um período, aparecem as concluídas ou com prazo nele.</p> : null}
      <Card>
        <DataTable caption="Demandas" rows={data.rows} rowKey={(r) => r.id}
          empty={<div className="p-4"><EmptyState icon={ListChecks} title="Nenhuma demanda encontrada" description="Ajuste os filtros, sincronize o Asana ou cadastre uma demanda manual." /></div>}
          mobileTitle={(r) => r.name}
          columns={[
            { key: "name", header: "Demanda", hideOnMobile: true, cell: (r) => (
              <span className="block max-w-md">
                <span className="font-medium">{r.name}</span>
                <span className="mt-0.5 block truncate text-xs text-subtle">{[r.section_name, r.assignee_name].filter(Boolean).join(" · ") || "—"}</span>
              </span>) },
            { key: "status", header: "Status", cell: (r) => <StatusBadge map={TASK_STATUS} value={taskStatus(r, today)} /> },
            { key: "source", header: "Origem", cell: (r) => r.source === "asana"
              ? (r.permalink_url ? <a href={r.permalink_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">Asana <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(abre em nova aba)</span></a> : "Asana")
              : <Badge tone="neutral">Manual</Badge> },
            { key: "ministry", header: "Ministério", cell: (r) => r.ministry_name },
            { key: "campaign", header: "Campanha", cell: (r) => r.campaign_name ?? <span className="text-subtle">—</span> },
            { key: "event", header: "Evento", cell: (r) => r.event_name ?? <span className="text-subtle">—</span> },
            { key: "due", header: "Prazo", cell: (r) => <span className="tabular whitespace-nowrap">{r.completed ? `Concluída ${formatDate(r.completed_at)}` : formatDate(r.due_on)}</span> },
            { key: "actions", header: <span className="sr-only">Ações</span>, mobileLabel: "Ações", cell: (r) => {
              const canManage = r.ministry_id != null && manageable.has(r.ministry_id);
              return (
                <span className="flex flex-wrap items-center gap-2">
                  {canManage ? (
                    <ActionDialog title="Vincular demanda" description={r.name} submitLabel="Salvar vínculos" action={linkTaskAction.bind(null, r.id)}
                      trigger={<Button size="sm" variant="outline"><Link2 /> Vincular</Button>}>
                      <ScopedSelects idPrefix={`lk-${r.id}`} lockMinistry compact ministries={manage.ministries} campaigns={manage.campaigns} events={manage.events}
                        defaults={{ ministryId: r.ministry_id, campaignId: r.campaign_id, eventId: r.event_id }} />
                      <p className="text-xs text-subtle">Somente campanhas e eventos do mesmo ministério. O vínculo manual é preservado nas próximas sincronizações.</p>
                    </ActionDialog>
                  ) : null}
                  {r.source === "manual" ? (canManage ? (
                    <form action={setTaskCompletedAction.bind(null, r.id, !r.completed)}>
                      <SubmitButton size="sm" variant={r.completed ? "ghost" : "secondary"}>{r.completed ? "Reabrir" : "Concluir"}</SubmitButton>
                    </form>
                  ) : null) : (
                    <span className="inline-flex items-center gap-1 text-xs text-subtle" title="O status desta demanda é atualizado apenas pela sincronização com o Asana">
                      <RefreshCw className="size-3" aria-hidden /> status sincronizado do Asana
                    </span>
                  )}
                </span>
              );
            } },
          ]} />
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/demandas" params={flatParams(sp)} />
      </Card>
    </>
  );
}
