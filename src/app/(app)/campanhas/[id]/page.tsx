import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, CircleDollarSign, ExternalLink, FileText, Link2, ListChecks, Package, Pencil, Target } from "lucide-react";
import { TrendChart } from "@/components/charts/charts";
import { ActionForm, ConfirmButton } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ChangeIndicator, KpiCard, MetricDisplay } from "@/components/ui/metric";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { ActivityFeed, StageTimeline } from "@/components/ui/timeline";
import { formatCurrency, formatDate, formatDateTime, formatMetric, formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { CAMPAIGN_STATUS, DELIVERABLE_STATUS, DELIVERABLE_TYPE, INVESTMENT_CATEGORY, TASK_STATUS, taskStatus } from "@/lib/labels";
import { goalProgress, metric } from "@/lib/metrics";
import { addDays, todayIso } from "@/lib/period";
import { requireActor } from "@/server/auth/current";
import { campaignPerformance } from "@/server/services/analytics";
import { getCampaign, linkCandidates } from "@/server/services/campaigns";
import { GOAL_METRICS } from "@/server/services/reports";
import { addGoalAction, addInvestmentAction, deleteGoalAction, deleteInvestmentAction, linkItemAction, saveCampaignNotesAction } from "../actions";

export const metadata: Metadata = { title: "Campanha" };

const STAGES = ["planning", "production", "awaiting_approval", "scheduled", "active", "completed"] as const;

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getCampaign(actor, id);
  if (!data) notFound();
  const { campaign: c, access } = data;
  const today = todayIso();
  const start = c.start_date ?? addDays(today, -89);
  const end = c.end_date && c.end_date < today ? c.end_date : today;
  const [perf, candidates] = await Promise.all([
    campaignPerformance(actor, id, start <= end ? start : end, end),
    access.canManage ? linkCandidates(actor, id) : Promise.resolve(null),
  ]);
  const path = `/campanhas/${id}`;
  const tasksDone = data.tasks.filter((t) => t.completed).length;
  const stageIdx = c.status === "archived" ? STAGES.length : STAGES.indexOf(c.status as (typeof STAGES)[number]);
  const comm = perf?.communication;
  const planned = data.investments?.filter((i) => i.kind === "planned").reduce((a, b) => a + b.amount, 0) ?? null;
  const realizedManual = data.investments?.filter((i) => i.kind === "realized").reduce((a, b) => a + b.amount, 0) ?? null;

  const goalActual = (key: string | null): number | null => {
    if (!perf || !key) return null;
    const p = perf.allTime;
    const o = perf.allOrganic;
    const eng = (x?: { total_interactions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null }) =>
      x ? (x.total_interactions ?? ([x.likes, x.comments, x.shares, x.saves].some((v) => v != null) ? [x.likes, x.comments, x.shares, x.saves].reduce<number>((a, b) => a + (b ?? 0), 0) : null)) : null;
    const map: Record<string, number | null> = {
      impressions: p.impressions, clicks: p.clicks, link_clicks: p.link_clicks, results: p.results, video_views: p.video_views, conversions: p.conversions,
      ig_engagement: eng(o.instagram), fb_engagement: eng(o.facebook), ig_views: o.instagram?.views ?? null,
    };
    return map[key] ?? null;
  };

  const overview = (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card>
          <CardHeader title="Visão geral" />
          <CardContent className="space-y-4 text-sm">
            {c.description ? <p className="whitespace-pre-line text-muted">{c.description}</p> : <p className="text-subtle">Sem descrição.</p>}
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-subtle">Objetivo</dt><dd className="mt-1 whitespace-pre-line">{c.objective ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Público-alvo</dt><dd className="mt-1 whitespace-pre-line">{c.target_audience ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Canais</dt><dd className="mt-1 flex flex-wrap gap-1">{data.channels.length ? data.channels.map((ch) => <Badge key={ch.id}>{ch.name}</Badge>) : "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Responsáveis</dt><dd className="mt-1">{data.responsibles.map((r) => r.name).join(", ") || "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Eventos relacionados</dt><dd className="mt-1 space-y-1">
                {data.events.length ? data.events.map((e) => <Link key={e.id} href={`/eventos/${e.id}`} className="block text-brand hover:underline">{e.name} · {formatDate(e.starts_at)}</Link>) : "—"}
              </dd></div>
              <div><dt className="text-xs font-medium text-subtle">Andamento operacional</dt><dd className="mt-1">{tasksDone} de {data.tasks.length} demandas concluídas · {data.deliverables.length} entregáveis</dd></div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Linha do tempo" description="Etapas da campanha conforme o status atual" />
          <CardContent>
            <StageTimeline steps={STAGES.map((s, i) => ({
              key: s, title: CAMPAIGN_STATUS[s]!.label,
              state: i < stageIdx ? "done" : i === stageIdx ? "current" : "upcoming",
              date: s === "active" ? formatDate(c.start_date) : s === "completed" ? formatDate(c.end_date) : undefined,
            }))} />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <KpiCard label="Demandas concluídas" value={metric.value(tasksDone)} hint={`de ${data.tasks.length}`} icon={ListChecks} />
        <KpiCard label="Entregáveis" value={metric.value(data.deliverables.length)} icon={Package} />
        <KpiCard label="Impressões (pago, período da campanha)" value={comm?.paid.impressions ?? metric.unavailable()} icon={Target} />
        <KpiCard label="Investimento realizado (Meta)" value={comm?.paid.spend ?? metric.restricted()} unit="currency" icon={CircleDollarSign} />
      </div>
    </div>
  );

  const goals = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Metas e resultados" description="Realizado calculado das métricas sincronizadas (acumulado) ou informado manualmente com fonte" />
        <CardContent>
          {data.goals.length ? (
            <ul className="space-y-4">
              {data.goals.map((g) => {
                const actual = g.metric_key ? goalActual(g.metric_key) : g.manual_actual_value;
                const pct = goalProgress(actual, g.target_value);
                return (
                  <li key={g.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{g.label}</p>
                      {access.canManage ? <ConfirmButton action={deleteGoalAction.bind(null, id, g.id)} label="Remover" confirm="Remover esta meta?" /> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                      <span>Meta: <strong className="tabular">{formatMetric(g.target_value, g.unit)}</strong></span>
                      <span>Realizado: <strong className="tabular">{actual == null ? "sem dado" : formatMetric(actual, g.unit)}</strong></span>
                      <span className="text-xs text-subtle">{g.metric_key ? `Fonte: ${GOAL_METRICS.find((m) => m.key === g.metric_key)?.label ?? g.metric_key}` : g.manual_actual_source ? `Fonte: ${g.manual_actual_source}` : "Sem fonte registrada"}</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct == null ? undefined : Math.min(100, Math.round(pct))} aria-label={`Progresso de ${g.label}`}>
                      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-subtle">{pct == null ? "Progresso indisponível" : `${formatPercent(pct, 0)} da meta`}</p>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState compact icon={Target} title="Nenhuma meta definida" />}
        </CardContent>
      </Card>
      {access.canManage ? (
        <Card>
          <CardHeader title="Adicionar meta" />
          <CardContent>
            <ActionForm action={addGoalAction.bind(null, id)} submitLabel="Adicionar meta">
              <Field label="Descrição" htmlFor="g-label"><Input id="g-label" name="label" required placeholder="Ex.: 50 mil impressões" /></Field>
              <Field label="Indicador automático" htmlFor="g-metric" hint="Deixe em branco para informar o realizado manualmente.">
                <Select id="g-metric" name="metricKey" defaultValue="">
                  <option value="">Manual</option>
                  {GOAL_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Meta" htmlFor="g-target"><Input id="g-target" name="targetValue" type="number" min={0} step="any" required /></Field>
                <Field label="Unidade" htmlFor="g-unit"><Select id="g-unit" name="unit"><option value="count">Quantidade</option><option value="currency">R$</option><option value="percent">%</option></Select></Field>
              </div>
              <Field label="Realizado (manual)" htmlFor="g-actual"><Input id="g-actual" name="manualActualValue" type="number" min={0} step="any" /></Field>
              <Field label="Fonte do realizado" htmlFor="g-source" hint="Obrigatória quando houver valor manual (ex.: sistema de inscrições)."><Input id="g-source" name="manualActualSource" /></Field>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );

  const tasks = (
    <Card>
      <CardHeader title="Demandas associadas" description="Status conforme a origem (Asana) — o portal não altera status sincronizado"
        action={<Link href={`/demandas?campanha=${id}`} className="text-xs font-medium text-brand">Abrir em Demandas</Link>} />
      <CardContent className="px-0">
        {data.tasks.length ? (
          <ul className="divide-y divide-border">
            {data.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-subtle">{t.source === "asana" ? "Asana" : "Manual"}{t.section_name ? ` · ${t.section_name}` : ""}{t.assignee_name ? ` · ${t.assignee_name}` : ""}{t.due_on ? ` · prazo ${formatDate(t.due_on)}` : ""}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge map={TASK_STATUS} value={taskStatus(t, today)} />
                  {t.permalink_url ? <a href={t.permalink_url} target="_blank" rel="noopener noreferrer" className="text-subtle hover:text-foreground" aria-label="Abrir no Asana"><ExternalLink className="size-4" /></a> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : <div className="px-5"><EmptyState compact icon={ListChecks} title="Nenhuma demanda associada" description="Associe demandas na tela Demandas ou configure regras de mapeamento do Asana." /></div>}
      </CardContent>
    </Card>
  );

  const deliverables = (
    <Card>
      <CardHeader title="Entregáveis" action={access.canManage ? <Button asChild size="sm"><Link href={`/entregaveis/novo?campanha=${id}`}>Registrar entregável</Link></Button> : null} />
      <CardContent>
        {data.deliverables.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.deliverables.map((d) => (
              <li key={d.id}><Link href={`/entregaveis/${d.id}`} className="block rounded-lg border border-border p-3 hover:border-border-strong">
                <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{d.title}</span><StatusBadge map={DELIVERABLE_STATUS} value={d.status} /></div>
                <p className="mt-1 text-xs text-subtle">{DELIVERABLE_TYPE[d.type]} · {d.delivered_at ? `entregue ${formatDate(d.delivered_at)}` : d.due_date ? `prazo ${formatDate(d.due_date)}` : "sem prazo"}</p>
              </Link></li>
            ))}
          </ul>
        ) : <EmptyState compact icon={Package} title="Nenhum entregável registrado" />}
      </CardContent>
    </Card>
  );

  const organicEntries = Object.entries(comm?.organic ?? {});
  const organic = (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {organicEntries.length ? organicEntries.map(([platform, v]) => (
          <Card key={platform} className="p-4">
            <p className="text-sm font-medium">{platform === "instagram" ? "Instagram" : "Facebook"} · {v.posts} publicações vinculadas</p>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <div><dt className="text-xs text-subtle">Alcance (soma)</dt><dd><MetricDisplay value={v.reach} size="md" /></dd></div>
              <div><dt className="text-xs text-subtle">Visualizações</dt><dd><MetricDisplay value={v.views} size="md" /></dd></div>
              <div><dt className="text-xs text-subtle">Engajamento</dt><dd><MetricDisplay value={v.engagement} size="md" /></dd>
                <ChangeIndicator change={comm?.organicChange[platform]} /></div>
            </dl>
          </Card>
        )) : <EmptyState compact className="md:col-span-2" icon={Link2} title="Nenhuma publicação vinculada" description="Vincule publicações orgânicas na seção abaixo." />}
      </div>
      <Card>
        <CardHeader title="Publicações vinculadas" />
        <CardContent>
          {data.posts.length ? (
            <ul className="divide-y divide-border">
              {data.posts.map((p) => {
                const m = perf?.posts.find((x) => x.id === p.id);
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0 flex-1"><span className="line-clamp-1 text-sm">{p.caption ?? "(sem legenda)"}</span>
                      <span className="text-xs text-subtle">{p.platform === "instagram" ? "Instagram" : "Facebook"} · {formatDate(p.published_at)} · {m?.engagement != null ? `${formatNumber(m.engagement)} interações` : "métricas indisponíveis"}</span></span>
                    <span className="flex items-center gap-2">
                      {p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-brand">abrir</a> : null}
                      {access.canManage ? (
                        <ActionForm action={linkItemAction.bind(null, id)} submitLabel="Desvincular" submitVariant="outline" inline>
                          <input type="hidden" name="kind" value="social_post" /><input type="hidden" name="itemId" value={p.id} /><input type="hidden" name="op" value="unlink" />
                        </ActionForm>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-subtle">Nenhuma publicação vinculada.</p>}
          {candidates?.posts.length ? (
            <div className="mt-4 border-t border-border pt-4">
              <ActionForm action={linkItemAction.bind(null, id)} submitLabel="Vincular publicação" inline>
                <input type="hidden" name="kind" value="social_post" />
                <Field label="Publicação do ministério" htmlFor="post-link" className="min-w-0 flex-1">
                  <Select id="post-link" name="itemId" required defaultValue="">
                    <option value="" disabled>Selecione…</option>
                    {candidates.posts.map((p) => <option key={p.id} value={p.id}>{formatDate(p.published_at)} · {p.platform} · {(p.caption ?? "").slice(0, 60)}</option>)}
                  </Select>
                </Field>
              </ActionForm>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );

  const paid = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Impressões" value={comm?.paid.impressions ?? metric.unavailable()} change={comm?.paidChange.impressions} />
        <KpiCard label="Cliques" value={comm?.paid.clicks ?? metric.unavailable()} change={comm?.paidChange.clicks} />
        <KpiCard label="Resultados" value={comm?.paid.results ?? metric.unavailable()} change={comm?.paidChange.results} />
        <KpiCard label="Investimento" value={comm?.paid.spend ?? metric.restricted()} unit="currency" currency={comm?.currency} change={comm?.paidChange.spend} />
        <KpiCard label="CTR (calculado)" value={comm?.paid.ctr ?? metric.unavailable()} unit="percent" />
        <KpiCard label="CPC (calculado)" value={comm?.paid.cpc ?? metric.unavailable()} unit="currency" currency={comm?.currency} />
        <KpiCard label="CPM (calculado)" value={comm?.paid.cpm ?? metric.unavailable()} unit="currency" currency={comm?.currency} />
        <KpiCard label="Custo por resultado" value={comm?.paid.costPerResult ?? metric.unavailable()} unit="currency" currency={comm?.currency} />
      </div>
      {perf && perf.series.rows.some((r) => r.impressions != null) ? (
        <Card><CardHeader title="Evolução (pago)" description={`${formatDate(start)} – ${formatDate(end)}`} /><CardContent>
          <TrendChart title="Impressões e cliques da campanha" rows={perf.series.rows.map((r) => ({ date: r.date, impressions: r.impressions, clicks: r.clicks }))}
            series={[{ key: "impressions", label: "Impressões", color: 0 }, { key: "clicks", label: "Cliques", color: 1 }]} />
        </CardContent></Card>
      ) : null}
      <Card>
        <CardHeader title="Campanhas publicitárias da Meta vinculadas" description="Entidades nativas da Meta, distintas da campanha de comunicação" />
        <CardContent>
          {data.externalCampaigns.length ? (
            <ul className="divide-y divide-border">
              {data.externalCampaigns.map((e) => {
                const m = perf?.external[e.id] ?? {};
                const reach = perf?.lifetimeReach.find((r) => r.entity_id === e.id);
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span className="min-w-0"><span className="block text-sm font-medium">{e.name}</span>
                      <span className="text-xs text-subtle">{e.account_name} · {e.objective ?? "objetivo não informado"} · {e.effective_status ?? "—"}</span></span>
                    <span className="flex flex-wrap items-center gap-4 text-xs">
                      <span>Impressões <strong className="tabular">{m.impressions == null ? "—" : formatNumber(m.impressions)}</strong></span>
                      <span>Cliques <strong className="tabular">{m.clicks == null ? "—" : formatNumber(m.clicks)}</strong></span>
                      {comm && !comm.investmentRestricted ? <span>Investimento <strong className="tabular">{m.spend == null ? "—" : formatCurrency(m.spend, comm.currency)}</strong></span> : null}
                      <span title="Alcance único informado pela Meta para toda a vida da campanha">Alcance único (vida) <strong className="tabular">{reach ? formatNumber(reach.v) : "—"}</strong></span>
                      {access.canManage ? (
                        <ActionForm action={linkItemAction.bind(null, id)} submitLabel="Desvincular" submitVariant="outline" inline>
                          <input type="hidden" name="kind" value="external_campaign" /><input type="hidden" name="itemId" value={e.id} /><input type="hidden" name="op" value="unlink" />
                        </ActionForm>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState compact icon={Link2} title="Nenhuma campanha da Meta vinculada" />}
          {candidates?.externalCampaigns.length ? (
            <div className="mt-4 border-t border-border pt-4">
              <ActionForm action={linkItemAction.bind(null, id)} submitLabel="Vincular campanha da Meta" inline>
                <input type="hidden" name="kind" value="external_campaign" />
                <Field label="Campanha da Meta (mesmo ministério)" htmlFor="ext-link" className="min-w-0 flex-1">
                  <Select id="ext-link" name="itemId" required defaultValue="">
                    <option value="" disabled>Selecione…</option>
                    {candidates.externalCampaigns.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.effective_status ?? "—"})</option>)}
                  </Select>
                </Field>
              </ActionForm>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );

  const investment = data.investments == null ? (
    <EmptyState icon={CircleDollarSign} title="Informações de investimento restritas" description="Seu perfil não tem permissão para visualizar investimentos deste ministério." />
  ) : (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Investimentos" description="Lançamentos do portal. O investimento em Meta Ads vem da sincronização." />
        <CardContent>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-surface-muted p-3"><p className="text-xs text-subtle">Planejado</p><p className="tabular text-lg font-semibold">{planned ? formatCurrency(planned) : "—"}</p></div>
            <div className="rounded-lg bg-surface-muted p-3"><p className="text-xs text-subtle">Realizado (lançamentos)</p><p className="tabular text-lg font-semibold">{realizedManual ? formatCurrency(realizedManual) : "—"}</p></div>
            <div className="rounded-lg bg-surface-muted p-3"><p className="text-xs text-subtle">Meta Ads no período da campanha</p><div className="text-lg"><MetricDisplay value={comm?.paid.spend ?? metric.unavailable()} unit="currency" size="md" /></div></div>
          </div>
          {data.investments.length ? (
            <ul className="divide-y divide-border text-sm">
              {data.investments.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-medium">{i.description}</span><span className="block text-xs text-subtle">{i.kind === "planned" ? "Planejado" : "Realizado"} · {INVESTMENT_CATEGORY[i.category]} · {formatDate(i.spent_on)}</span></span>
                  <span className="flex items-center gap-2"><span className="tabular font-medium">{formatCurrency(i.amount, i.currency)}</span>
                    {access.canManage ? <ConfirmButton action={deleteInvestmentAction.bind(null, path, i.id)} label="Remover" confirm="Remover este lançamento?" /> : null}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-subtle">Nenhum lançamento.</p>}
        </CardContent>
      </Card>
      {access.canManage ? (
        <Card>
          <CardHeader title="Registrar investimento" />
          <CardContent>
            <ActionForm action={addInvestmentAction.bind(null, path)} submitLabel="Registrar">
              <input type="hidden" name="ministryId" value={c.ministry_id} /><input type="hidden" name="campaignId" value={id} />
              <Field label="Tipo" htmlFor="i-kind"><Select id="i-kind" name="kind"><option value="realized">Realizado</option><option value="planned">Planejado</option></Select></Field>
              <Field label="Categoria" htmlFor="i-cat"><Select id="i-cat" name="category">{Object.entries(INVESTMENT_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
              <Field label="Descrição" htmlFor="i-desc"><Input id="i-desc" name="description" required /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Valor (R$)" htmlFor="i-amount"><Input id="i-amount" name="amount" type="number" min={0} step="0.01" required inputMode="decimal" /></Field>
                <Field label="Data" htmlFor="i-date"><Input id="i-date" name="spentOn" type="date" /></Field>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );

  const history = (
    <Card>
      <CardHeader title="Histórico" description="Registro de alterações e vínculos" />
      <CardContent>
        {data.history.length ? <ActivityFeed items={data.history.map((h) => ({ id: String(h.id), title: h.summary ?? h.action, meta: `${h.actor_name ?? "Sistema"} · ${formatDateTime(h.created_at)}` }))} />
          : <p className="text-sm text-subtle">Sem registros.</p>}
      </CardContent>
    </Card>
  );

  const final = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Relatório final" description="Resumo, aprendizados e observações — textos editoriais, separados dos resultados observados"
          action={<Button asChild size="sm" variant="secondary"><Link href={`/relatorios/instantaneo?escopo=campaign&campanha=${id}&inicio=${start}&fim=${end}`}><FileText /> Pré-visualizar relatório</Link></Button>} />
        <CardContent>
          {access.canManage ? (
            <ActionForm action={saveCampaignNotesAction.bind(null, id)} submitLabel="Salvar registro" resetOnSuccess={false}>
              <Field label="Resumo final" htmlFor="finalSummary"><Textarea id="finalSummary" name="finalSummary" defaultValue={c.final_summary ?? ""} rows={4} /></Field>
              <Field label="Aprendizados" htmlFor="learnings"><Textarea id="learnings" name="learnings" defaultValue={c.learnings ?? ""} rows={4} /></Field>
              <Field label="Observações" htmlFor="observations"><Textarea id="observations" name="observations" defaultValue={c.observations ?? ""} rows={3} /></Field>
            </ActionForm>
          ) : (
            <dl className="space-y-4 text-sm">
              <div><dt className="text-xs font-medium text-subtle">Resumo final</dt><dd className="mt-1 whitespace-pre-line">{c.final_summary ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Aprendizados</dt><dd className="mt-1 whitespace-pre-line">{c.learnings ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-subtle">Observações</dt><dd className="mt-1 whitespace-pre-line">{c.observations ?? "—"}</dd></div>
            </dl>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Fontes" />
        <CardContent className="space-y-2 text-sm">
          <p>Meta Ads: {perf?.sources.meta_ads.connected ? `atualizado ${formatRelative(perf.sources.meta_ads.lastUpdate)}` : "sem conexão"}</p>
          <p>Orgânico: {perf?.sources.organic.connected ? `atualizado ${formatRelative(perf.sources.organic.lastUpdate)}` : "sem conexão"}</p>
          <p>Asana: {perf?.sources.asana.connected ? `atualizado ${formatRelative(perf.sources.asana.lastUpdate)}` : "sem dados"}</p>
          <p className="text-xs text-subtle">Período de análise: {formatDate(start)} – {formatDate(end)}</p>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Campanhas", href: "/campanhas" }, { label: c.ministry_name, href: `/ministerios/${c.ministry_slug}` }, { label: c.name }]}
        eyebrow={<span className="flex items-center gap-2"><StatusBadge map={CAMPAIGN_STATUS} value={c.status} />{c.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}</span>}
        title={c.name}
        description={<span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{formatDate(c.start_date)} – {formatDate(c.end_date)} · {c.ministry_name}</span>}
        actions={access.canManage ? <Button asChild variant="secondary"><Link href={`/campanhas/${id}/editar`}><Pencil /> Editar</Link></Button> : null}
      />
      <Tabs tabs={[
        { value: "geral", label: "Visão geral", content: overview },
        { value: "metas", label: `Metas (${data.goals.length})`, content: goals },
        { value: "demandas", label: `Demandas (${data.tasks.length})`, content: tasks },
        { value: "entregaveis", label: `Entregáveis (${data.deliverables.length})`, content: deliverables },
        { value: "organico", label: "Desempenho orgânico", content: organic },
        { value: "pago", label: "Desempenho pago", content: paid },
        { value: "investimento", label: "Investimento", content: investment },
        { value: "historico", label: "Histórico", content: history },
        { value: "final", label: "Relatório final", content: final },
      ]} />
    </>
  );
}
