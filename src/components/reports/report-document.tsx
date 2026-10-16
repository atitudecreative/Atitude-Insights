import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ChangeIndicator } from "@/components/ui/metric";
import { formatCurrency, formatDate, formatDateTime, formatMetric, formatNumber, formatPercent } from "@/lib/format";
import { CAMPAIGN_STATUS, DELIVERABLE_STATUS, DELIVERABLE_TYPE, INVESTMENT_CATEGORY, REPORT_SCOPE } from "@/lib/labels";
import { compare } from "@/lib/metrics";
import type { ReportData, ReportFinancials } from "@/server/services/reports";

export interface ReportText {
  title: string;
  objectives?: string | null;
  executiveSummary?: string | null;
  learnings?: string | null;
  observations?: string | null;
}

function Section({ n, title, children, note }: { n: number; title: string; children: ReactNode; note?: string }) {
  return (
    <section className="break-inside-avoid border-t border-border pt-6" aria-labelledby={`sec-${n}`}>
      <h2 id={`sec-${n}`} className="flex items-baseline gap-2 text-lg font-semibold tracking-tight">
        <span className="tabular text-sm text-subtle">{String(n).padStart(2, "0")}</span>{title}
      </h2>
      {note ? <p className="mt-0.5 text-xs text-subtle">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted/50 p-3">
      <p className="text-xs text-subtle">{label}</p>
      <p className="tabular mt-1 text-xl font-semibold">{value}</p>
      {sub ? <div className="mt-1">{sub}</div> : null}
    </div>
  );
}

const n = (v: number | null | undefined) => (v == null ? <span className="text-sm font-normal text-subtle">indisponível</span> : formatNumber(v));

/** Relatório de prestação de contas (HTML) — mesma estrutura do PDF. */
export function ReportDocument({ data, financials, text, investmentRestricted }: { data: ReportData; financials: ReportFinancials | null; text: ReportText; investmentRestricted: boolean }) {
  const p = data.params;
  const subject = data.subject.campaignName ?? data.subject.eventName ?? data.subject.ministryName ?? "Consolidado da agência";
  let i = 0;
  return (
    <article className="mx-auto max-w-4xl space-y-6 rounded-card border border-border bg-surface p-5 shadow-card sm:p-8 print:border-0 print:shadow-none">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{REPORT_SCOPE[p.scopeType]}</Badge>
          {data.subject.isDemo ? <Badge tone="warning">Dados de demonstração</Badge> : null}
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{text.title}</h1>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
          <div><dt className="inline text-subtle">Escopo: </dt><dd className="inline font-medium text-foreground">{subject}</dd></div>
          <div><dt className="inline text-subtle">Ministério(s): </dt><dd className="inline">{data.subject.ministryNames.join(", ") || "—"}</dd></div>
          <div><dt className="inline text-subtle">Período de referência: </dt><dd className="inline tabular">{formatDate(p.start)} a {formatDate(p.end)}</dd></div>
          <div><dt className="inline text-subtle">Dados gerados em: </dt><dd className="inline tabular">{formatDateTime(data.generatedAt)}</dd></div>
        </dl>
      </header>

      <Section n={++i} title="Objetivos">
        {text.objectives || data.objectives.length ? (
          <div className="space-y-2 text-sm">
            {text.objectives ? <p className="whitespace-pre-line">{text.objectives}</p> : null}
            {data.objectives.map((o) => <p key={o.label}><span className="font-medium">{o.label}:</span> {o.text}</p>)}
          </div>
        ) : <p className="text-sm text-subtle">Objetivos não registrados.</p>}
      </Section>

      <Section n={++i} title="Resumo executivo">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg bg-surface-muted/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Resultados observados</p>
            <p className="mb-2 text-xs text-subtle">Gerado automaticamente a partir dos dados — sem interpretação</p>
            <ul className="list-disc space-y-1 pl-4 text-sm">{data.facts.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Análise da agência</p>
            <p className="mb-2 text-xs text-subtle">Interpretação editorial</p>
            {text.executiveSummary ? <p className="whitespace-pre-line text-sm">{text.executiveSummary}</p> : <p className="text-sm text-subtle">Sem análise registrada.</p>}
          </div>
        </div>
      </Section>

      <Section n={++i} title="Demandas concluídas" note="Concluídas no período, conforme a origem (Asana ou registro manual)">
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Concluídas" value={formatNumber(data.operational.tasksCompleted)} sub={<ChangeIndicator change={data.operational.tasksCompletedChange} />} />
          <Stat label="Em aberto (hoje)" value={formatNumber(data.operational.tasksOpen)} />
          <Stat label="Atrasadas (hoje)" value={formatNumber(data.operational.tasksOverdue)} />
          <Stat label="Campanhas ativas" value={formatNumber(data.operational.activeCampaigns)} />
        </div>
        {data.tasks.length ? (
          <ul className="divide-y divide-border text-sm">
            {data.tasks.slice(0, 60).map((t, k) => (
              <li key={k} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{t.name}</span><span className="text-xs text-subtle">{t.campaign ?? t.ministry} · {formatDate(t.completed_at)}</span></li>
            ))}
            {data.tasks.length > 60 ? <li className="py-1.5 text-xs text-subtle">+ {data.tasks.length - 60} demandas</li> : null}
          </ul>
        ) : <p className="text-sm text-subtle">Nenhuma demanda concluída no período.</p>}
      </Section>

      <Section n={++i} title="Entregáveis" note="Aprovados ou entregues no período">
        {data.deliverables.length ? (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {data.deliverables.map((d, k) => (
              <li key={k} className="rounded-lg border border-border px-3 py-2">
                <p className="font-medium">{d.title}</p>
                <p className="text-xs text-subtle">{DELIVERABLE_TYPE[d.type] ?? d.type} · {DELIVERABLE_STATUS[d.status]?.label ?? d.status} · {formatDate(d.date)}{d.campaign ? ` · ${d.campaign}` : ""}</p>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-subtle">Nenhum entregável no período.</p>}
      </Section>

      <Section n={++i} title="Campanhas executadas">
        {data.campaigns.length ? (
          <ul className="divide-y divide-border text-sm">
            {data.campaigns.map((c, k) => (
              <li key={k} className="py-2"><p className="font-medium">{c.name} <span className="text-xs font-normal text-subtle">· {CAMPAIGN_STATUS[c.status]?.label}</span></p>
                <p className="text-xs text-subtle">{c.ministry} · {formatDate(c.start_date)} – {formatDate(c.end_date)}{c.objective ? ` · ${c.objective}` : ""}</p></li>
            ))}
          </ul>
        ) : <p className="text-sm text-subtle">Nenhuma campanha com atividade no período.</p>}
      </Section>

      <Section n={++i} title="Indicadores orgânicos" note="Valor mais recente de cada publicação do período. Alcance não é somado entre plataformas.">
        {Object.keys(data.organic).length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(data.organic).map(([platform, o]) => (
              <div key={platform} className="rounded-lg border border-border p-3">
                <p className="font-medium">{platform === "instagram" ? "Instagram" : "Facebook"} · {o.posts} publicações</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-subtle">Alcance (soma)</dt><dd className="tabular font-semibold">{n(o.reach)}</dd></div>
                  <div><dt className="text-xs text-subtle">Visualizações</dt><dd className="tabular font-semibold">{n(o.views)}</dd></div>
                  <div><dt className="text-xs text-subtle">Interações</dt><dd className="tabular font-semibold">{n(o.engagement)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-subtle">Sem dados orgânicos para o escopo (nenhuma conta associada ou nenhuma publicação no período).</p>}
        {data.topPosts.length ? (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Publicações de melhor desempenho</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {data.topPosts.map((t, k) => <li key={k}>{(t.caption ?? "(sem legenda)").slice(0, 110)} <span className="text-xs text-subtle">— {t.platform}, {formatDate(t.published_at)}, {t.engagement == null ? "sem métrica" : `${formatNumber(t.engagement)} interações`}</span></li>)}
            </ol>
          </div>
        ) : null}
      </Section>

      <Section n={++i} title="Indicadores pagos (Meta Ads)" note="Fornecidos pela Meta; CTR calculado pelo portal (cliques ÷ impressões × 100)">
        {data.paid.available || data.paid.impressions != null ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Impressões" value={n(data.paid.impressions)} />
            <Stat label="Alcance (não deduplicado)" value={n(data.paid.reach)} />
            <Stat label="Cliques" value={n(data.paid.clicks)} />
            <Stat label="Resultados" value={n(data.paid.results)} />
            <Stat label="CTR" value={data.paid.ctr == null ? n(null) : formatPercent(data.paid.ctr)} />
          </div>
        ) : <p className="text-sm text-subtle">Nenhuma conta de anúncios associada a este escopo.</p>}
      </Section>

      <Section n={++i} title="Investimentos">
        {financials ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Meta Ads (período)" value={financials.paidSpend == null ? n(null) : formatCurrency(financials.paidSpend, financials.currency)}
                sub={<ChangeIndicator change={compare(financials.paidSpend, financials.paidSpendPrevious)} />} />
              <Stat label="Lançamentos realizados" value={financials.realizedManual == null ? "—" : formatCurrency(financials.realizedManual)} />
              <Stat label="Planejado" value={financials.planned == null ? "—" : formatCurrency(financials.planned)} />
              <Stat label="Custo por resultado" value={financials.costPerResult == null ? n(null) : formatCurrency(financials.costPerResult, financials.currency)} />
            </div>
            {financials.items.length ? (
              <table className="mt-3 w-full text-sm">
                <caption className="sr-only">Lançamentos de investimento</caption>
                <thead><tr className="border-b border-border text-left text-xs text-subtle"><th className="py-1.5 font-medium">Descrição</th><th className="py-1.5 font-medium">Tipo</th><th className="py-1.5 text-right font-medium">Valor</th></tr></thead>
                <tbody>{financials.items.map((it, k) => (
                  <tr key={k} className="border-b border-border/60"><td className="py-1.5">{it.description}<span className="block text-xs text-subtle">{INVESTMENT_CATEGORY[it.category]}{it.campaign ? ` · ${it.campaign}` : ""} · {formatDate(it.spent_on)}</span></td>
                    <td className="py-1.5">{it.kind === "planned" ? "Planejado" : "Realizado"}</td><td className="tabular py-1.5 text-right">{formatCurrency(it.amount)}</td></tr>
                ))}</tbody>
              </table>
            ) : null}
          </>
        ) : <p className="text-sm text-subtle">{investmentRestricted ? "Seção restrita: seu perfil não tem permissão para visualizar investimentos deste escopo." : "Sem informações de investimento."}</p>}
      </Section>

      <Section n={++i} title="Comparativos" note="Período atual versus o período imediatamente anterior de mesma duração">
        <table className="w-full text-sm">
          <caption className="sr-only">Comparativo com o período anterior</caption>
          <thead><tr className="border-b border-border text-left text-xs text-subtle"><th className="py-1.5 font-medium">Indicador</th><th className="py-1.5 text-right font-medium">Atual</th><th className="py-1.5 text-right font-medium">Anterior</th><th className="py-1.5 text-right font-medium">Variação</th></tr></thead>
          <tbody>
            {([
              ["Demandas concluídas", data.operational.tasksCompleted, data.operational.tasksCompleted - (data.operational.tasksCompletedChange.absolute ?? 0), data.operational.tasksCompletedChange],
              ["Entregáveis", data.operational.deliverablesProduced, data.operational.deliverablesProduced - (data.operational.deliverablesChange.absolute ?? 0), data.operational.deliverablesChange],
              ["Impressões (pago)", data.paid.impressions, data.paid.previous.impressions, compare(data.paid.impressions, data.paid.previous.impressions)],
              ["Cliques (pago)", data.paid.clicks, data.paid.previous.clicks, compare(data.paid.clicks, data.paid.previous.clicks)],
              ["Resultados (pago)", data.paid.results, data.paid.previous.results, compare(data.paid.results, data.paid.previous.results)],
              ...Object.entries(data.organic).map(([pl, o]) => [`Interações ${pl === "instagram" ? "Instagram" : "Facebook"}`, o.engagement, o.previousEngagement, compare(o.engagement, o.previousEngagement)] as const),
            ] as const).map(([label, cur, prev, ch]) => (
              <tr key={label} className="border-b border-border/60">
                <td className="py-1.5">{label}</td><td className="tabular py-1.5 text-right">{cur == null ? "—" : formatNumber(cur)}</td>
                <td className="tabular py-1.5 text-right">{prev == null || ch.reason === "no_previous" ? "—" : formatNumber(prev)}</td>
                <td className="py-1.5 text-right">{ch.percent == null ? <span className="text-xs text-subtle">n/c</span> : formatPercent(ch.percent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section n={++i} title="Metas versus resultados">
        {data.goals.length ? (
          <table className="w-full text-sm">
            <caption className="sr-only">Metas</caption>
            <thead><tr className="border-b border-border text-left text-xs text-subtle"><th className="py-1.5 font-medium">Meta</th><th className="py-1.5 text-right font-medium">Alvo</th><th className="py-1.5 text-right font-medium">Realizado</th><th className="py-1.5 text-right font-medium">%</th></tr></thead>
            <tbody>{data.goals.map((g, k) => (
              <tr key={k} className="border-b border-border/60"><td className="py-1.5">{g.label}<span className="block text-xs text-subtle">{g.campaign} · fonte: {g.actualSource}</span></td>
                <td className="tabular py-1.5 text-right">{formatMetric(g.target, g.unit)}</td><td className="tabular py-1.5 text-right">{g.actual == null ? "—" : formatMetric(g.actual, g.unit)}</td>
                <td className="tabular py-1.5 text-right">{g.progress == null ? "—" : formatPercent(g.progress, 0)}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="text-sm text-subtle">Nenhuma meta definida para as campanhas do escopo.</p>}
        {data.eventResults.length ? (
          <div className="mt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Resultados do evento (registrados com fonte)</p>
            <ul className="space-y-1 text-sm">{data.eventResults.map((r, k) => <li key={k}><span className="font-medium">{r.label}:</span> {r.value == null ? "—" : formatMetric(r.value, r.unit)} <span className="text-xs text-subtle">— fonte: {r.source}</span></li>)}</ul>
          </div>
        ) : null}
      </Section>

      <Section n={++i} title="Aprendizados">
        {text.learnings || data.notes.learnings.length ? (
          <div className="space-y-2 whitespace-pre-line text-sm">{text.learnings ? <p>{text.learnings}</p> : null}{data.notes.learnings.map((l, k) => <p key={k}>{l}</p>)}</div>
        ) : <p className="text-sm text-subtle">Sem aprendizados registrados.</p>}
      </Section>

      <Section n={++i} title="Observações">
        {text.observations || data.notes.observations.length ? (
          <div className="space-y-2 whitespace-pre-line text-sm">{text.observations ? <p>{text.observations}</p> : null}{data.notes.observations.map((l, k) => <p key={k}>{l}</p>)}</div>
        ) : <p className="text-sm text-subtle">Sem observações.</p>}
      </Section>

      <Section n={++i} title="Fontes e atualização">
        <ul className="space-y-1 text-sm">
          {data.sources.map((s) => <li key={s.label} className="flex flex-wrap justify-between gap-2"><span>{s.label}</span><span className="text-xs text-subtle">{s.status}{s.lastUpdate ? ` · atualizado em ${formatDateTime(s.lastUpdate)}` : ""}</span></li>)}
        </ul>
        <p className="mt-3 text-xs text-subtle">Resultados observados são dados informados pelas fontes; metas são definidas pela equipe; análises são interpretações editoriais. A coincidência temporal entre entregas e resultados não estabelece relação causal.</p>
      </Section>
    </article>
  );
}
