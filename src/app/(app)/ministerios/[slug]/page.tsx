import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, Megaphone, Package, PlugZap, Plus } from "lucide-react";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/format";
import { CAMPAIGN_STATUS, DELIVERABLE_STATUS, DELIVERABLE_TYPE } from "@/lib/labels";
import { parsePeriod } from "@/lib/period";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { getDashboard } from "@/server/services/analytics";
import { listCampaigns } from "@/server/services/campaigns";
import { listDeliverables } from "@/server/services/deliverables";
import { getMinistryBySlug } from "@/server/services/ministries";
import { CHANNEL_FILTER, filterOptions } from "@/server/services/options";
import { listReports } from "@/server/services/reports";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat("pt-BR", { hour: "numeric", hour12: false, timeZone: "America/Sao_Paulo" }).format(new Date()));
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export default async function MinistryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const found = await getMinistryBySlug(actor, slug);
  if (!found) notFound();
  const { ministry, access } = found;
  const mode = ministry.is_demo ? "demo" : "production";
  const period = parsePeriod({ periodo: param(sp, "periodo"), inicio: param(sp, "inicio"), fim: param(sp, "fim") });
  const [d, options, campaigns, deliverables, reports] = await Promise.all([
    getDashboard(actor, { mode, start: period.start, end: period.end, ministryId: ministry.id, campaignId: param(sp, "campanha"), eventId: param(sp, "evento"), channel: param(sp, "canal") }),
    filterOptions(actor, mode, ministry.id),
    listCampaigns(actor, { mode, ministryId: ministry.id, status: "active", pageSize: 6 }),
    listDeliverables(actor, { mode, ministryId: ministry.id, pageSize: 6 }),
    listReports(actor, { ministryId: ministry.id, limit: 5 }),
  ]);
  const hasAnything = d.operational.tasksTotal > 0 || campaigns.total > 0 || deliverables.total > 0 || d.sources.meta_ads.connected || d.sources.organic.connected;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Ministérios", href: "/ministerios" }, { label: ministry.name }]}
        eyebrow={<span className="text-sm text-subtle">{greeting()}, {actor.name.split(" ")[0]} 👋</span>}
        title={<span className="flex items-center gap-3"><span aria-hidden className="size-3 rounded-full" style={{ background: ministry.color ?? "var(--brand)" }} />{ministry.name}{ministry.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}</span>}
        description={ministry.description ?? `O que a agência de comunicação realizou para ${ministry.name} e os resultados observados.`}
        actions={
          <>
            <Button asChild variant="secondary"><Link href={`/relatorios/instantaneo?ministerio=${ministry.id}&inicio=${period.start}&fim=${period.end}`}><FileText /> Relatório do período</Link></Button>
            {access.canManage ? <Button asChild><Link href={`/campanhas/nova?ministerio=${ministry.id}`}><Plus /> Nova campanha</Link></Button> : null}
          </>
        }
      />
      <FilterBar filters={[
        { name: "campanha", label: "Campanha", allLabel: "Todas", options: options.campaigns.map((c) => ({ value: c.id, label: c.name })) },
        { name: "evento", label: "Evento", options: options.events.map((e) => ({ value: e.id, label: e.name })) },
        { name: "canal", label: "Canal", options: CHANNEL_FILTER },
      ]} />

      {!hasAnything ? (
        <div className="mb-8 grid gap-3 md:grid-cols-3">
          <EmptyState icon={Megaphone} title="Nenhuma campanha cadastrada" description="Cadastre campanhas e eventos para organizar as entregas deste ministério."
            action={access.canManage ? <Button asChild size="sm"><Link href={`/campanhas/nova?ministerio=${ministry.id}`}>Cadastrar campanha</Link></Button> : null} />
          <EmptyState icon={PlugZap} title="Demandas do Asana não associadas" description="Um administrador precisa mapear projetos, seções ou campos do Asana para este ministério." />
          <EmptyState icon={PlugZap} title="Contas da Meta não associadas" description="Associe contas de anúncios, páginas e perfis do Instagram a este ministério para ver resultados." />
        </div>
      ) : null}

      <DashboardView d={d} linkQuery={`ministerio=${ministry.id}`} showMinistryTable={false} periodLabel={period.label} />

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Campanhas ativas" action={<Link className="text-xs font-medium text-brand" href={`/campanhas?ministerio=${ministry.id}`}>Ver todas</Link>} />
          <CardContent>
            {campaigns.rows.length ? (
              <ul className="space-y-2">
                {campaigns.rows.map((c) => (
                  <li key={c.id}><Link href={`/campanhas/${c.id}`} className="flex items-center justify-between gap-2 rounded-lg p-2 hover:bg-surface-muted">
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{c.name}</span><span className="text-xs text-subtle">{formatDate(c.start_date)} – {formatDate(c.end_date)}</span></span>
                    <StatusBadge map={CAMPAIGN_STATUS} value={c.status} />
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState compact icon={Megaphone} title="Nenhuma campanha ativa" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Entregáveis recentes" action={<Link className="text-xs font-medium text-brand" href={`/entregaveis?ministerio=${ministry.id}`}>Ver todos</Link>} />
          <CardContent>
            {deliverables.rows.length ? (
              <ul className="space-y-2">
                {deliverables.rows.map((x) => (
                  <li key={x.id}><Link href={`/entregaveis/${x.id}`} className="flex items-center justify-between gap-2 rounded-lg p-2 hover:bg-surface-muted">
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{x.title}</span><span className="text-xs text-subtle">{DELIVERABLE_TYPE[x.type]} · {x.campaign_name ?? "sem campanha"}</span></span>
                    <StatusBadge map={DELIVERABLE_STATUS} value={x.status} />
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState compact icon={Package} title="Nenhum entregável registrado" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Relatórios disponíveis" action={<Link className="text-xs font-medium text-brand" href={`/relatorios?ministerio=${ministry.id}`}>Ver todos</Link>} />
          <CardContent>
            {reports.length ? (
              <ul className="space-y-2">
                {reports.map((r) => (
                  <li key={r.id}><Link href={`/relatorios/${r.id}`} className="flex items-center justify-between gap-2 rounded-lg p-2 hover:bg-surface-muted">
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{r.title}</span><span className="text-xs text-subtle">{formatDate(r.period_start)} – {formatDate(r.period_end)}</span></span>
                    <Badge tone={r.status === "published" ? "success" : "neutral"}>{r.status === "published" ? "Publicado" : "Rascunho"}</Badge>
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState compact icon={FileText} title="Nenhum relatório publicado" description="Gere um relatório instantâneo do período pelo botão acima." />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
