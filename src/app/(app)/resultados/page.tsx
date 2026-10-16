import type { Metadata } from "next";
import { Calculator, Database, Download, Info, Trophy } from "lucide-react";
import { OrganicKpis, PaidKpis, SectionTitle, TrendSection } from "@/components/dashboard/sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { formatDate, formatNumber, formatRelative } from "@/lib/format";
import { parsePeriod } from "@/lib/period";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { getDashboard, resolveScope, topPosts, type AnalyticsFilters } from "@/server/services/analytics";
import { asUser } from "@/server/services/context";
import { getDataMode } from "@/server/services/mode";
import { CHANNEL_FILTER, filterOptions } from "@/server/services/options";

export const metadata: Metadata = { title: "Resultados" };

const PROVIDED = [
  ["Impressões", "Quantidade de vezes que os anúncios foram exibidos (Meta Ads)."],
  ["Alcance", "Pessoas únicas alcançadas, segundo a Meta. Não é somado entre plataformas; somas entre dias ou campanhas não são deduplicadas."],
  ["Cliques e cliques no link", "Cliques registrados pela Meta nos anúncios."],
  ["Resultados", "Ações do objetivo de cada campanha, conforme a Meta (ex.: mensagens, cadastros)."],
  ["Investimento", "Valor gasto informado pela Meta. Visível apenas para perfis com permissão de investimento."],
  ["Visualizações e interações", "Métricas orgânicas de cada publicação (valor mais recente informado pelo Instagram ou Facebook)."],
] as const;

const DERIVED = [
  ["CTR", "cliques ÷ impressões × 100"],
  ["CPC", "investimento ÷ cliques"],
  ["CPM", "investimento ÷ impressões × 1.000"],
  ["Custo por resultado", "investimento ÷ resultados"],
  ["Engajamento", "curtidas + comentários + compartilhamentos + salvamentos (quando a fonte não informa o total de interações)"],
] as const;

export default async function ResultsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const period = parsePeriod({ periodo: param(sp, "periodo"), inicio: param(sp, "inicio"), fim: param(sp, "fim") });
  const ministryId = param(sp, "ministerio");
  const filters: AnalyticsFilters = { mode, start: period.start, end: period.end, ministryId, campaignId: param(sp, "campanha"), channel: param(sp, "canal") };
  const [d, posts, options] = await Promise.all([
    getDashboard(actor, filters),
    asUser(actor, async (trx) => topPosts(trx, await resolveScope(trx, filters), period.start, period.end, 10)),
    filterOptions(actor, mode, ministryId),
  ]);
  const exportQuery = new URLSearchParams(Object.entries({ periodo: param(sp, "periodo"), inicio: param(sp, "inicio"), fim: param(sp, "fim"), ministerio: ministryId })
    .filter(([, v]) => v) as Array<[string, string]>).toString();
  const sources = [
    { key: "meta_ads", label: "Meta Ads", kind: "Mídia paga", s: d.sources.meta_ads },
    { key: "organic", label: "Instagram e Facebook", kind: "Orgânico", s: d.sources.organic },
    { key: "asana", label: "Asana", kind: "Demandas", s: d.sources.asana },
  ];
  const showPaid = !filters.channel || filters.channel === "meta_ads";
  const showOrganic = filters.channel !== "meta_ads";

  return (
    <>
      <PageHeader title="Resultados" description="Desempenho da comunicação: mídia paga e orgânico sempre separados, com a origem de cada indicador."
        actions={<Button asChild variant="secondary"><a href={`/api/exportar/metricas${exportQuery ? `?${exportQuery}` : ""}`}><Download /> Exportar métricas diárias (CSV)</a></Button>} />
      <FilterBar filters={[
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "campanha", label: "Campanha", allLabel: "Todas", options: options.campaigns.map((c) => ({ value: c.id, label: c.name })) },
        { name: "canal", label: "Canal", options: CHANNEL_FILTER },
      ]} />
      <p className="-mt-3 mb-5 text-xs text-subtle">Período: <span className="font-medium text-muted">{period.label}</span> · comparações com o período anterior de mesma duração</p>

      <SectionTitle title="Disponibilidade dos dados" description="Fontes conectadas para o escopo selecionado" />
      <ul className="grid gap-3 md:grid-cols-3" aria-label="Fontes de dados">
        {sources.map((x) => (
          <li key={x.key}>
            <Card className="h-full p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium"><Database className="mr-1.5 inline size-4 text-subtle" aria-hidden />{x.label}</p>
                <Badge tone={x.s.syncing ? "info" : x.s.connected ? "success" : "muted"} dot>{x.s.syncing ? "Sincronizando" : x.s.connected ? "Conectada" : "Sem conexão"}</Badge>
              </div>
              <p className="mt-2 text-xs text-subtle">{x.kind}{x.s.accounts ? ` · ${x.s.accounts} ativo(s) vinculado(s)` : ""}</p>
              <p className="mt-1 text-xs text-muted">{x.s.connected ? `Última atualização: ${x.s.lastUpdate ? formatRelative(x.s.lastUpdate) : "aguardando primeira coleta"}` : "Nenhuma conta fornece este dado para o escopo."}</p>
            </Card>
          </li>
        ))}
      </ul>

      {showPaid ? (
        <>
          <SectionTitle title="Mídia paga · Meta Ads" description="Nível de campanha (evita dupla contagem com anúncios). Indicadores “calculado” são do portal." />
          <PaidKpis d={d} />
        </>
      ) : null}

      {showOrganic ? (
        <>
          <SectionTitle title="Orgânico · por plataforma" description="Instagram e Facebook têm definições próprias e não são somados nem comparados entre si" />
          <OrganicKpis d={d} />
        </>
      ) : null}

      <div className="mt-4"><TrendSection d={d} /></div>

      {showOrganic ? (
        <>
          <SectionTitle title="Publicações de melhor desempenho" description="Top 10 por interações no período (valor mais recente de cada publicação)" />
          <Card>
            <DataTable caption="Publicações de melhor desempenho" rows={posts} rowKey={(p) => p.id}
              empty={<div className="p-4"><EmptyState compact icon={Trophy} title="Sem publicações no período" description={d.sources.organic.connected ? "Nenhuma publicação associada ao escopo." : "Nenhuma conta orgânica conectada."} /></div>}
              mobileTitle={(p) => <span className="line-clamp-2">{p.caption || "(sem legenda)"}</span>}
              columns={[
                { key: "rank", header: "#", hideOnMobile: true, cell: (p) => <span className="tabular text-subtle">{posts.indexOf(p) + 1}</span> },
                { key: "caption", header: "Publicação", hideOnMobile: true, cell: (p) => (
                  <span className="block max-w-md">
                    <span className="line-clamp-2">{p.caption || "(sem legenda)"}</span>
                    {p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">abrir</a> : null}
                  </span>) },
                { key: "platform", header: "Plataforma", cell: (p) => (p.platform === "instagram" ? "Instagram" : "Facebook") },
                { key: "ministry", header: "Ministério", cell: (p) => p.ministry_name },
                { key: "date", header: "Publicação", mobileLabel: "Data", cell: (p) => <span className="tabular">{formatDate(p.published_at)}</span> },
                { key: "reach", header: "Alcance", align: "right", cell: (p) => (p.metrics.reach == null ? <span className="text-subtle">—</span> : formatNumber(p.metrics.reach)) },
                { key: "views", header: "Visualizações", align: "right", cell: (p) => (p.metrics.views == null ? <span className="text-subtle">—</span> : formatNumber(p.metrics.views)) },
                { key: "eng", header: "Interações", align: "right", cell: (p) => (p.engagement == null ? <span className="text-subtle">sem métrica</span> : <strong>{formatNumber(p.engagement)}</strong>) },
              ]} />
          </Card>
        </>
      ) : null}

      <SectionTitle title="Definições das métricas" description="De onde vem cada número" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Fornecidas pela Meta" description="Valores informados pelas APIs, sem recálculo" />
          <CardContent>
            <dl className="space-y-3 text-sm">
              {PROVIDED.map(([k, v]) => <div key={k}><dt className="font-medium">{k}</dt><dd className="text-muted">{v}</dd></div>)}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Calculadas pelo portal" description="Derivadas das métricas fornecidas, no período filtrado" />
          <CardContent>
            <dl className="space-y-3 text-sm">
              {DERIVED.map(([k, v]) => (
                <div key={k}><dt className="flex items-center gap-1.5 font-medium"><Calculator className="size-3.5 text-subtle" aria-hidden />{k}</dt>
                  <dd className="font-mono text-xs text-muted">{k} = {v}</dd></div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-subtle">Sem denominador (ex.: zero impressões) o indicador aparece como indisponível — nunca como zero.</p>
          </CardContent>
        </Card>
      </div>

      <p className="mt-8 flex items-start gap-2 text-xs text-subtle">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Alcance nunca é somado entre plataformas. Os indicadores mostram resultados observados nas fontes conectadas; a coincidência de período entre entregas e resultados não implica relação de causa.
      </p>
    </>
  );
}
