import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, ClipboardCheck, ExternalLink, FileText, Info, Link2, ListChecks, MapPin, Megaphone, Package, Pencil } from "lucide-react";
import { OrganicKpis, PaidKpis, SectionTitle, TrendSection } from "@/components/dashboard/sections";
import { IntentForm } from "@/components/ops/intent-form";
import { ActionForm, ConfirmButton } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { KpiCard } from "@/components/ui/metric";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { ActivityFeed, StageTimeline } from "@/components/ui/timeline";
import { formatDate, formatDateTime, formatEventDate, formatMetric, formatRelative } from "@/lib/format";
import { CAMPAIGN_STATUS, DELIVERABLE_STATUS, DELIVERABLE_TYPE, EVENT_STATUS, TASK_STATUS, taskStatus } from "@/lib/labels";
import { metric } from "@/lib/metrics";
import { todayIso } from "@/lib/period";
import { requireActor } from "@/server/auth/current";
import { getDashboard } from "@/server/services/analytics";
import { eventStages, getEvent, type EventStage } from "@/server/services/events";
import { addEventResultAction, deleteEventResultAction, saveEventConsolidationAction } from "../actions";
import { toIsoDay } from "../utils";

export const metadata: Metadata = { title: "Evento" };

const STAGE_LABEL: Record<EventStage, string> = {
  planning: "Planejamento", production: "Produção", promotion: "Divulgação", event: "Período do evento",
  post_event: "Pós-evento", consolidation: "Consolidação de resultados",
};

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getEvent(actor, id);
  if (!data) notFound();
  const { event: e, access } = data;
  const today = todayIso();
  const eventStartDay = toIsoDay(e.starts_at);
  const eventEndDay = toIsoDay(e.ends_at ?? e.starts_at);
  const createdDay = toIsoDay(e.created_at);
  const promoStart = e.promotion_start ?? (createdDay < eventStartDay ? createdDay : eventStartDay);
  const analysisEnd = eventEndDay < today ? eventEndDay : today;
  const analysisStart = promoStart <= analysisEnd ? promoStart : analysisEnd;
  const d = await getDashboard(actor, { mode: e.is_demo ? "demo" : "production", start: analysisStart, end: analysisEnd, ministryId: e.ministry_id, eventId: id });
  const stages = eventStages(e);
  const tasksDone = data.tasks.filter((t) => t.completed).length;
  const reportHref = `/relatorios/instantaneo?escopo=event&evento=${id}&inicio=${promoStart}&fim=${eventEndDay}`;

  const stageDate: Record<EventStage, string | undefined> = {
    planning: `Desde ${formatDate(e.created_at)}`,
    production: e.status === "confirmed" || e.status === "finished" ? "Evento confirmado" : undefined,
    promotion: e.promotion_start || e.promotion_end ? `${formatDate(e.promotion_start)} – ${formatDate(e.promotion_end)}` : "Período não definido",
    event: e.ends_at ? `${formatDateTime(e.starts_at)} – ${formatDateTime(e.ends_at)}` : formatDateTime(e.starts_at),
    post_event: `Após ${formatDate(e.ends_at ?? e.starts_at)}`,
    consolidation: e.results_consolidated_at ? `Consolidado em ${formatDate(e.results_consolidated_at)}` : "Pendente",
  };

  const overview = (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card>
          <CardHeader title="Visão geral" />
          <CardContent className="space-y-4 text-sm">
            {e.description ? <p className="whitespace-pre-line text-muted">{e.description}</p> : <p className="text-subtle">Sem descrição.</p>}
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><dt className="text-xs font-medium text-subtle">Objetivo de comunicação</dt><dd className="mt-1 whitespace-pre-line">{e.communication_objective ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Período de divulgação</dt><dd className="mt-1">{e.promotion_start || e.promotion_end ? `${formatDate(e.promotion_start)} – ${formatDate(e.promotion_end)}` : "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Responsáveis</dt><dd className="mt-1">{data.responsibles.map((r) => r.name).join(", ") || "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Links</dt><dd className="mt-1 space-y-1">
                {e.links.length ? e.links.map((l, i) => (
                  <a key={`${l.url}-${i}`} href={l.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1.5 text-brand hover:underline">
                    <ExternalLink className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{l.label}</span>
                  </a>
                )) : "—"}
              </dd></div>
              <div><dt className="text-xs font-medium text-subtle">Campanhas relacionadas</dt><dd className="mt-1 space-y-1">
                {data.campaigns.length ? data.campaigns.map((c) => (
                  <Link key={c.id} href={`/campanhas/${c.id}`} className="flex flex-wrap items-center gap-2 text-brand hover:underline">{c.name}<StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></Link>
                )) : "—"}
              </dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <KpiCard label="Demandas concluídas" value={metric.value(tasksDone)} hint={`de ${data.tasks.length}`} icon={ListChecks} />
        <KpiCard label="Entregáveis" value={metric.value(data.deliverables.length)} icon={Package} />
        <KpiCard label="Resultados registrados" value={metric.value(data.results.length)} icon={ClipboardCheck} hint="Com fonte declarada" />
      </div>
    </div>
  );

  const tasks = (
    <Card>
      <CardHeader title="Demandas do evento" description="Vinculadas ao evento ou às campanhas relacionadas · status conforme a origem"
        action={<Link href={`/demandas?evento=${id}`} className="text-xs font-medium text-brand">Abrir em Demandas</Link>} />
      <CardContent className="px-0">
        {data.tasks.length ? (
          <ul className="divide-y divide-border">
            {data.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-subtle">{t.source === "asana" ? "Asana" : "Manual"}{t.assignee_name ? ` · ${t.assignee_name}` : ""}{t.due_on ? ` · prazo ${formatDate(t.due_on)}` : ""}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge map={TASK_STATUS} value={taskStatus(t, today)} />
                  {t.permalink_url ? <a href={t.permalink_url} target="_blank" rel="noopener noreferrer" className="text-subtle hover:text-foreground" aria-label="Abrir no Asana"><ExternalLink className="size-4" /></a> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : <div className="px-5"><EmptyState compact icon={ListChecks} title="Nenhuma demanda associada" description="Vincule demandas ao evento na tela Demandas." /></div>}
      </CardContent>
    </Card>
  );

  const deliverables = (
    <Card>
      <CardHeader title="Entregáveis" action={access.canManage ? <Button asChild size="sm"><Link href={`/entregaveis/novo?evento=${id}`}>Registrar entregável</Link></Button> : null} />
      <CardContent>
        {data.deliverables.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.deliverables.map((x) => (
              <li key={x.id}><Link href={`/entregaveis/${x.id}`} className="block rounded-lg border border-border p-3 hover:border-border-strong">
                <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{x.title}</span><StatusBadge map={DELIVERABLE_STATUS} value={x.status} /></div>
                <p className="mt-1 text-xs text-subtle">{DELIVERABLE_TYPE[x.type] ?? x.type} · {x.delivered_at ? `entregue ${formatDate(x.delivered_at)}` : x.due_date ? `prazo ${formatDate(x.due_date)}` : "sem prazo"}</p>
              </Link></li>
            ))}
          </ul>
        ) : <EmptyState compact icon={Package} title="Nenhum entregável registrado" />}
      </CardContent>
    </Card>
  );

  const promotion = (
    <div>
      <div role="note" className="mb-5 flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-4 py-3 text-sm text-info">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Métricas digitais das campanhas vinculadas ({formatDate(analysisStart)} – {formatDate(analysisEnd)}). Elas medem a divulgação e <strong>não comprovam presença física nem inscrições</strong> — para isso, registre os resultados do evento com a fonte.</span>
      </div>
      {data.campaigns.length ? (
        <>
          <SectionTitle title="Mídia paga" description="Meta Ads das campanhas vinculadas ao evento" />
          <PaidKpis d={d} />
          <SectionTitle title="Orgânico" description="Publicações vinculadas às campanhas do evento — plataformas não são somadas" />
          <OrganicKpis d={d} />
          <div className="mt-4"><TrendSection d={d} /></div>
        </>
      ) : (
        <EmptyState icon={Megaphone} title="Nenhuma campanha vinculada" description="Os resultados de divulgação vêm das campanhas de comunicação relacionadas ao evento."
          action={access.canManage ? <Button asChild size="sm" variant="secondary"><Link href={`/eventos/${id}/editar`}>Vincular campanhas</Link></Button> : null} />
      )}
    </div>
  );

  const results = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Resultados do evento" description="Informados manualmente, sempre com a fonte (ex.: sistema de inscrições, contagem na porta)" />
        <CardContent>
          {data.results.length ? (
            <ul className="divide-y divide-border">
              {data.results.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-xs text-subtle">Fonte: {r.source} · registrado {formatDate(r.created_at)}</span>
                    {r.notes ? <span className="mt-1 block whitespace-pre-line text-xs text-muted">{r.notes}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular text-lg font-semibold">{r.value == null ? <span className="text-sm font-normal text-subtle">sem valor</span> : formatMetric(r.value, r.unit)}</span>
                    {access.canManage ? <ConfirmButton action={deleteEventResultAction.bind(null, id, r.id)} label="Remover" confirm="Remover este resultado?" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <EmptyState compact icon={ClipboardCheck} title="Nenhum resultado registrado" description="Presença, inscrições, decisões e outros resultados observados no evento." />}
        </CardContent>
      </Card>
      {access.canManage ? (
        <Card>
          <CardHeader title="Registrar resultado" />
          <CardContent>
            <ActionForm action={addEventResultAction.bind(null, id)} submitLabel="Registrar">
              <Field label="Resultado" htmlFor="r-label"><Input id="r-label" name="label" required maxLength={200} placeholder="Ex.: Pessoas presentes" /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Valor" htmlFor="r-value"><Input id="r-value" name="value" type="number" min={0} step="any" inputMode="decimal" /></Field>
                <Field label="Unidade" htmlFor="r-unit"><Select id="r-unit" name="unit"><option value="count">Quantidade</option><option value="currency">R$</option><option value="percent">%</option></Select></Field>
              </div>
              <Field label="Fonte" htmlFor="r-source" hint="Obrigatória: de onde vem este número."><Input id="r-source" name="source" required minLength={2} maxLength={300} placeholder="Ex.: Sistema de inscrições" /></Field>
              <Field label="Observações" htmlFor="r-notes"><Textarea id="r-notes" name="notes" rows={2} /></Field>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );

  const final = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Relatório final" description={e.results_consolidated_at ? `Resultados consolidados em ${formatDateTime(e.results_consolidated_at)}` : "Resumo dos resultados e observações — textos editoriais, separados dos números observados"}
          action={<Button asChild size="sm" variant="secondary"><Link href={reportHref}><FileText /> Pré-visualizar relatório</Link></Button>} />
        <CardContent>
          {access.canManage ? (
            <IntentForm action={saveEventConsolidationAction.bind(null, id)} buttons={[
              { intent: "save", label: "Salvar registro", variant: "secondary" },
              ...(e.results_consolidated_at ? [] : [{ intent: "consolidate", label: "Consolidar resultados", confirm: "Consolidar os resultados? O evento será marcado como realizado." }]),
            ]}>
              <Field label="Resumo dos resultados" htmlFor="resultsSummary"><Textarea id="resultsSummary" name="resultsSummary" defaultValue={e.results_summary ?? ""} rows={5} /></Field>
              <Field label="Observações" htmlFor="observations"><Textarea id="observations" name="observations" defaultValue={e.observations ?? ""} rows={3} /></Field>
            </IntentForm>
          ) : (
            <dl className="space-y-4 text-sm">
              <div><dt className="text-xs font-medium text-subtle">Resumo dos resultados</dt><dd className="mt-1 whitespace-pre-line">{e.results_summary ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Observações</dt><dd className="mt-1 whitespace-pre-line">{e.observations ?? "—"}</dd></div>
            </dl>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Fontes" />
        <CardContent className="space-y-2 text-sm">
          <p>Meta Ads: {d.sources.meta_ads.connected ? `atualizado ${formatRelative(d.sources.meta_ads.lastUpdate)}` : "sem conexão"}</p>
          <p>Orgânico: {d.sources.organic.connected ? `atualizado ${formatRelative(d.sources.organic.lastUpdate)}` : "sem conexão"}</p>
          <p>Resultados presenciais: {data.results.length} registro(s) manuais com fonte</p>
          <p className="text-xs text-subtle">Período do relatório: {formatDate(promoStart)} – {formatDate(eventEndDay)}</p>
        </CardContent>
      </Card>
    </div>
  );

  const history = (
    <Card>
      <CardHeader title="Histórico" description="Registro de alterações e resultados" />
      <CardContent>
        {data.history.length ? <ActivityFeed items={data.history.map((h) => ({ id: String(h.id), title: h.summary ?? h.action, meta: `${h.actor_name ?? "Sistema"} · ${formatDateTime(h.created_at)}` }))} />
          : <p className="text-sm text-subtle">Sem registros.</p>}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Eventos", href: "/eventos" }, { label: e.ministry_name, href: `/ministerios/${e.ministry_slug}` }, { label: e.name }]}
        eyebrow={<span className="flex items-center gap-2"><StatusBadge map={EVENT_STATUS} value={e.status} />{e.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}</span>}
        title={e.name}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{formatEventDate(e.starts_at)}{e.ends_at ? ` – ${formatEventDate(e.ends_at)}` : ""}</span>
            {e.location ? <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" aria-hidden />{e.location}</span> : null}
            <span>{e.ministry_name}</span>
          </span>
        }
        actions={access.canManage ? <Button asChild variant="secondary"><Link href={`/eventos/${id}/editar`}><Pencil /> Editar</Link></Button> : null}
      />
      <Card className="mb-6">
        <CardHeader title="Etapas de comunicação" description="Derivadas das datas cadastradas" />
        <CardContent>
          <StageTimeline steps={stages.map((s) => ({ key: s.key, title: STAGE_LABEL[s.key], state: s.state, date: stageDate[s.key] }))} />
        </CardContent>
      </Card>
      <Tabs tabs={[
        { value: "geral", label: "Visão geral", content: overview },
        { value: "demandas", label: `Demandas (${data.tasks.length})`, content: tasks },
        { value: "entregaveis", label: `Entregáveis (${data.deliverables.length})`, content: deliverables },
        { value: "divulgacao", label: "Resultados de divulgação", content: promotion },
        { value: "resultados", label: `Resultados do evento (${data.results.length})`, content: results },
        { value: "final", label: "Relatório final", content: final },
        { value: "historico", label: "Histórico", content: history },
      ]} />
      <p className="mt-6 flex items-start gap-2 text-xs text-subtle"><Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />As demandas e entregáveis incluem os vinculados diretamente ao evento e às campanhas relacionadas.</p>
    </>
  );
}
