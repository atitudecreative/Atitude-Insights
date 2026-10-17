import {
  AlertTriangle, CalendarDays, CheckCircle2, CircleDollarSign, Clock, Eye, Flame, Heart, ListChecks, Megaphone, MousePointerClick,
  Package, PlugZap, Target, Users, Building2, Camera, ThumbsUp, Trophy,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiCard, MetricDisplay } from "@/components/ui/metric";
import { ActivityFeed } from "@/components/ui/timeline";
import { DataTable } from "@/components/ui/table";
import { BarsChart, DonutChart, TrendChart } from "@/components/charts/charts";
import { formatCurrency, formatDate, formatEventDate, formatMetric, formatNumber, formatRelative } from "@/lib/format";
import { INTEGRATION_STATUS } from "@/lib/labels";
import { metric } from "@/lib/metrics";
import type { Dashboard } from "@/server/services/analytics";

export function SectionTitle({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-2 first:mt-0">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-subtle">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function OperationalKpis({ d, linkQuery }: { d: Dashboard; linkQuery: string }) {
  const o = d.operational;
  const q = linkQuery ? `&${linkQuery}` : "";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label="Campanhas ativas" value={metric.value(o.activeCampaigns)} icon={Megaphone} href={`/campanhas?status=active${q}`} />
      <KpiCard label="Eventos em andamento" value={metric.value(o.ongoingEvents)} icon={CalendarDays} hint="Em divulgação ou acontecendo" href={`/eventos?quando=proximos${q}`} />
      <KpiCard label="Demandas concluídas" value={metric.value(o.tasksCompleted)} change={o.tasksCompletedChange} icon={CheckCircle2} href={`/demandas?status=completed${q}`} />
      <KpiCard label="Demandas em andamento" value={metric.value(o.tasksOpen)} icon={ListChecks} href={`/demandas?status=open${q}`} />
      <KpiCard label="Demandas atrasadas" value={metric.value(o.tasksOverdue)} icon={AlertTriangle} invertChange href={`/demandas?status=overdue${q}`}
        className={o.tasksOverdue > 0 ? "border-danger/30" : undefined} />
      <KpiCard label="Entregáveis produzidos" value={metric.value(o.deliverablesProduced)} change={o.deliverablesChange} icon={Package} hint="Aprovados ou entregues" href={`/entregaveis?status=delivered${q}`} />
      <KpiCard label="Ministérios atendidos" value={metric.value(o.ministriesServed)} icon={Building2} hint="Com entregas no período" href="/ministerios" />
      <KpiCard label="Total de demandas" value={metric.value(o.tasksTotal)} icon={Target} hint="Ativas no escopo" href={`/demandas${q ? `?${linkQuery}` : ""}`} />
    </div>
  );
}

export function PaidKpis({ d }: { d: Dashboard }) {
  const c = d.communication;
  const cur = c.currency;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Investimento em anúncios" value={c.paid.spend} unit="currency" currency={cur} change={c.paidChange.spend} icon={CircleDollarSign}
          hint={c.investmentPartial ? "Somente ministérios autorizados" : undefined} />
        <KpiCard label="Impressões (pago)" value={c.paid.impressions} change={c.paidChange.impressions} icon={Eye} />
        <KpiCard label="Alcance de anúncios" value={c.paid.reach} icon={Users} hint="Soma diária por campanha — não deduplicado" />
        <KpiCard label="Cliques" value={c.paid.clicks} change={c.paidChange.clicks} icon={MousePointerClick} />
        <KpiCard label="Resultados" value={c.paid.results} change={c.paidChange.results} icon={Target} hint="Conforme objetivo da campanha" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        {([
          ["CTR", c.paid.ctr, "percent"], ["CPC", c.paid.cpc, "currency"], ["CPM", c.paid.cpm, "currency"],
          ["Custo por resultado", c.paid.costPerResult, "currency"], ["Visualizações de vídeo", c.paid.videoViews, "count"],
        ] as const).map(([label, value, unit]) => (
          <div key={label} className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="text-xs text-subtle">{label}{label !== "Visualizações de vídeo" ? " · calculado" : ""}</p>
            <div className="mt-1"><MetricDisplay value={value} unit={unit} currency={cur} size="md" /></div>
          </div>
        ))}
      </div>
    </>
  );
}

const PLATFORM = { instagram: { label: "Instagram", icon: Camera }, facebook: { label: "Facebook", icon: ThumbsUp } } as const;

export function OrganicKpis({ d }: { d: Dashboard }) {
  const entries = Object.entries(d.communication.organic) as Array<[keyof typeof PLATFORM, Dashboard["communication"]["organic"][string]]>;
  if (!entries.length) {
    return (
      <EmptyState icon={PlugZap} compact title="Nenhuma conta orgânica conectada para este escopo"
        description="Conecte páginas do Facebook e contas profissionais do Instagram e associe-as aos ministérios em Administração → Integrações." />
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entries.map(([platform, v]) => {
        const P = PLATFORM[platform];
        return (
          <Card key={platform} className="p-4">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-medium"><P.icon className="size-4 text-subtle" aria-hidden />{P.label}</p>
              <Badge tone="neutral">{formatNumber(v.posts)} publicações</Badge>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <div><dt className="text-xs text-subtle">Alcance*</dt><dd className="mt-1"><MetricDisplay value={v.reach} size="md" /></dd></div>
              <div><dt className="text-xs text-subtle">Visualizações</dt><dd className="mt-1"><MetricDisplay value={v.views} size="md" /></dd></div>
              <div><dt className="text-xs text-subtle">Engajamento</dt><dd className="mt-1"><MetricDisplay value={v.engagement} size="md" /></dd></div>
            </dl>
          </Card>
        );
      })}
      <p className="text-xs text-subtle md:col-span-2">
        * Alcance orgânico somado por publicação, com o valor mais recente de cada uma. A mesma pessoa pode ter visto várias publicações; plataformas diferentes nunca são somadas.
      </p>
    </div>
  );
}

export function TrendSection({ d }: { d: Dashboard }) {
  const rows = d.series.rows;
  const hasPaid = rows.some((r) => r.impressions != null);
  const hasOrganic = rows.some((r) => r.organic_views != null || r.organic_interactions != null);
  const bucketLabel = d.series.bucket === "day" ? "por dia" : d.series.bucket === "week" ? "por semana" : "por mês";
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Evolução dos resultados" description={`Pago: impressões e cliques ${bucketLabel} (escalas separadas)`} />
        <CardContent className="space-y-2">
          {hasPaid ? (
            <>
              <p className="text-xs font-medium text-muted">Impressões</p>
              <TrendChart title="Impressões de anúncios" height={180} rows={rows.map((r) => ({ date: r.date, impressions: r.impressions }))}
                series={[{ key: "impressions", label: "Impressões", color: 0 }]} />
              <p className="text-xs font-medium text-muted">Cliques</p>
              <TrendChart title="Cliques em anúncios" height={140} rows={rows.map((r) => ({ date: r.date, clicks: r.clicks }))}
                series={[{ key: "clicks", label: "Cliques", color: 1 }]} />
            </>
          ) : (
            <EmptyState compact icon={Eye} title="Sem métricas pagas no período" description={d.sources.meta_ads.connected ? "Nenhum dado de anúncio para os filtros selecionados." : "Nenhuma conta de anúncios conectada para este escopo."} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Engajamento orgânico" description={`Interações das publicações, pela data de publicação (${bucketLabel})`} />
        <CardContent>
          {hasOrganic ? (
            <TrendChart title="Interações orgânicas" rows={rows.map((r) => ({ date: r.date, organic_interactions: r.organic_interactions }))}
              series={[{ key: "organic_interactions", label: "Interações", color: 2 }]} />
          ) : (
            <EmptyState compact icon={Heart} title="Sem publicações no período" description={d.sources.organic.connected ? "Nenhuma publicação associada ao escopo no período." : "Nenhuma conta orgânica conectada."} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function OperationsCharts({ d }: { d: Dashboard }) {
  const rows = d.series.rows;
  const any = rows.some((r) => r.tasks_done > 0);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Demandas concluídas" description={d.series.bucket === "day" ? "Por dia de conclusão" : d.series.bucket === "week" ? "Por semana de conclusão" : "Por mês de conclusão"} />
        <CardContent>
          {any ? <BarsChart title="Demandas concluídas por período" xKey="date" rows={rows.map((r) => ({ date: r.date, tasks_done: r.tasks_done }))} series={[{ key: "tasks_done", label: "Concluídas", color: 0 }]} />
            : <EmptyState compact icon={CheckCircle2} title="Nenhuma demanda concluída no período" description={d.sources.asana.connected ? "As demandas sincronizadas do Asana aparecerão aqui ao serem concluídas." : "Conecte o Asana ou cadastre demandas manualmente."} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Demandas por status" description="Situação atual" />
        <CardContent>
          {d.distribution.length ? <DonutChart title="Distribuição das demandas por status" items={d.distribution} />
            : <EmptyState compact icon={ListChecks} title="Sem demandas registradas" />}
        </CardContent>
      </Card>
    </div>
  );
}

export function MinistryPerformance({ d, showSpend }: { d: Dashboard; showSpend: boolean }) {
  if (d.byMinistry.length <= 1) return null;
  return (
    <Card>
      <CardHeader title="Desempenho por ministério" description="Entregas no período e alcance de mídia paga" />
      <CardContent className="px-0 pb-2">
        <DataTable caption="Desempenho por ministério" rows={d.byMinistry} rowKey={(m) => m.id}
          mobileTitle={(m) => <Link href={`/ministerios/${m.slug}`} className="hover:text-brand">{m.name}</Link>}
          columns={[
            { key: "name", header: "Ministério", hideOnMobile: true, cell: (m) => <Link href={`/ministerios/${m.slug}`} className="font-medium hover:text-brand">{m.name}</Link> },
            { key: "tasks", header: "Demandas concluídas", align: "right", cell: (m) => formatNumber(m.tasks_done) },
            { key: "deliverables", header: "Entregáveis", align: "right", cell: (m) => formatNumber(m.deliverables) },
            { key: "campaigns", header: "Campanhas ativas", align: "right", cell: (m) => formatNumber(m.active_campaigns) },
            { key: "posts", header: "Publicações", align: "right", cell: (m) => formatNumber(m.organic_posts) },
            { key: "impressions", header: "Impressões (pago)", align: "right", cell: (m) => (m.impressions == null ? <span className="text-subtle">sem dado</span> : formatNumber(m.impressions, { compact: true })) },
            ...(showSpend ? [{ key: "spend", header: "Investimento", align: "right" as const, cell: (m: Dashboard["byMinistry"][number]) => (m.spend == null ? <span className="text-subtle">sem dado</span> : formatCurrency(m.spend)) }] : []),
          ]} />
      </CardContent>
    </Card>
  );
}

export function InvestmentByCampaign({ d }: { d: Dashboard }) {
  if (d.byCampaign == null) return null;
  return (
    <Card>
      <CardHeader title="Investimento por campanha" description="Realizado no período (lançamentos + Meta Ads vinculados) e planejado" />
      <CardContent>
        {d.byCampaign.length ? (
          <BarsChart title="Investimento por campanha" horizontal unit="currency" height={Math.max(180, d.byCampaign.length * 44)}
            rows={d.byCampaign.map((c) => ({ label: c.name, realized: c.realized, planned: c.planned }))}
            series={[{ key: "realized", label: "Realizado", color: 0 }, { key: "planned", label: "Planejado", color: 3 }]} />
        ) : <EmptyState compact icon={CircleDollarSign} title="Nenhum investimento registrado" description="Registre investimentos nas campanhas ou vincule campanhas da Meta." />}
      </CardContent>
    </Card>
  );
}

export function UpcomingEvents({ d }: { d: Dashboard }) {
  return (
    <Card>
      <CardHeader title="Próximos eventos" action={<Link href="/eventos?quando=proximos" className="text-xs font-medium text-brand">Ver todos</Link>} />
      <CardContent>
        {d.events.length ? (
          <ul className="space-y-3">
            {d.events.map((e) => (
              <li key={e.id}>
                <Link href={`/eventos/${e.id}`} className="flex items-start gap-3 rounded-lg p-1 hover:bg-surface-muted">
                  <span className="flex w-12 shrink-0 flex-col items-center rounded-lg border border-border bg-surface-muted py-1 text-center">
                    <span className="text-[10px] font-medium uppercase text-subtle">{new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "America/Sao_Paulo" }).format(new Date(e.starts_at)).replace(".", "")}</span>
                    <span className="tabular text-lg font-semibold leading-5">{new Intl.DateTimeFormat("pt-BR", { day: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(e.starts_at))}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{e.name}</span>
                    <span className="block truncate text-xs text-subtle">{e.ministry_name} · {formatEventDate(e.starts_at)}{e.location ? ` · ${e.location}` : ""}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState compact icon={CalendarDays} title="Nenhum evento futuro cadastrado" />}
      </CardContent>
    </Card>
  );
}

export function UpcomingDeliveries({ d }: { d: Dashboard }) {
  return (
    <Card>
      <CardHeader title="Próximas entregas" description="Prazos nos próximos 14 dias e atrasados" />
      <CardContent>
        {d.deliveries.length ? (
          <ul className="divide-y divide-border">
            {d.deliveries.map((x) => (
              <li key={`${x.kind}-${x.id}`} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <Link href={x.kind === "task" ? `/demandas?q=${encodeURIComponent(x.title.slice(0, 40))}` : `/entregaveis/${x.id}`} className="block truncate text-sm font-medium hover:text-brand">{x.title}</Link>
                  <span className="text-xs text-subtle">{x.kind === "task" ? "Demanda" : "Entregável"} · {x.ministry_name}</span>
                </span>
                <Badge tone={x.overdue ? "danger" : "neutral"}>{x.overdue ? "Atrasada · " : ""}{formatDate(x.due)}</Badge>
              </li>
            ))}
          </ul>
        ) : <EmptyState compact icon={Clock} title="Nenhuma entrega com prazo próximo" />}
      </CardContent>
    </Card>
  );
}

export function RecentActivity({ d }: { d: Dashboard }) {
  return (
    <Card>
      <CardHeader title="Atividades recentes" />
      <CardContent>
        {d.activity.length ? (
          <ActivityFeed items={d.activity.map((a) => ({
            id: String(a.id), title: a.summary,
            meta: `${a.actor_name ?? "Sistema"} · ${a.ministry_name ?? ""} · ${formatRelative(a.created_at)}`,
          }))} />
        ) : <EmptyState compact icon={Flame} title="Nenhuma atividade registrada ainda" />}
      </CardContent>
    </Card>
  );
}

export function TopPosts({ d }: { d: Dashboard }) {
  return (
    <Card>
      <CardHeader title="Publicações de melhor desempenho" description="Por interações (valor mais recente)" action={<Link href="/resultados" className="text-xs font-medium text-brand">Ver resultados</Link>} />
      <CardContent>
        {d.posts.length ? (
          <ol className="space-y-3">
            {d.posts.map((p, i) => (
              <li key={p.id} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-muted">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm">{p.caption || "(sem legenda)"}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    {p.platform === "instagram" ? "Instagram" : "Facebook"} · {p.ministry_name} · {formatDate(p.published_at)}
                    {p.permalink ? <> · <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">abrir</a></> : null}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-semibold">{p.engagement == null ? <span className="text-xs font-normal text-subtle">sem métrica</span> : formatNumber(p.engagement)}</span>
              </li>
            ))}
          </ol>
        ) : <EmptyState compact icon={Trophy} title="Sem publicações no período" />}
      </CardContent>
    </Card>
  );
}

export function SyncAlerts({ d }: { d: Dashboard }) {
  if (!d.alerts) return null;
  const { accounts, failedJobs } = d.alerts;
  if (!accounts.length && !failedJobs) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
        <CheckCircle2 className="size-4 text-success" aria-hidden /> Integrações sem alertas.
        <Link href="/admin/sincronizacoes" className="ml-auto text-xs font-medium text-brand">Histórico</Link>
      </div>
    );
  }
  return (
    <div role="status" className="space-y-2 rounded-card border border-warning/30 bg-warning-soft/60 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-warning"><AlertTriangle className="size-4" aria-hidden /> Alertas de sincronização</p>
      <ul className="space-y-1 text-sm">
        {accounts.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.label}</span>
            <Badge tone={INTEGRATION_STATUS[a.status]?.tone ?? "warning"}>{INTEGRATION_STATUS[a.status]?.label ?? a.status}</Badge>
            {a.token_expires_at && new Date(a.token_expires_at) > new Date() ? <span className="text-xs text-muted">Credencial expira {formatRelative(a.token_expires_at)}</span> : null}
            {a.last_error ? <span className="text-xs text-muted">{a.last_error.slice(0, 140)}</span> : null}
          </li>
        ))}
        {failedJobs ? <li className="text-xs text-muted">{failedJobs} sincronização(ões) falharam nas últimas 24 h.</li> : null}
      </ul>
      <Link href="/admin/sincronizacoes" className="inline-block text-xs font-medium text-brand">Ver detalhes</Link>
    </div>
  );
}

export function SourcesStrip({ d }: { d: Dashboard }) {
  const items = [
    { key: "asana", label: "Asana (demandas)", s: d.sources.asana },
    { key: "meta_ads", label: "Meta Ads (pago)", s: d.sources.meta_ads },
    { key: "organic", label: "Instagram/Facebook (orgânico)", s: d.sources.organic },
  ];
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Fontes de dados">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1">
          <span className={`size-1.5 rounded-full ${i.s.syncing ? "bg-info" : i.s.connected ? "bg-success" : "bg-border-strong"}`} aria-hidden />
          <span className="font-medium">{i.label}</span>
          <span className="text-subtle">{i.s.syncing ? "sincronizando" : i.s.connected ? (i.s.lastUpdate ? `atualizado ${formatRelative(i.s.lastUpdate)}` : "conectado") : "sem conexão"}</span>
        </li>
      ))}
    </ul>
  );
}

export { formatMetric };
