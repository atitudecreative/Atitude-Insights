import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { formatCurrency, formatDate, formatDateTime, formatMetric, formatNumber, formatPercent } from "@/lib/format";
import { CAMPAIGN_STATUS, DELIVERABLE_STATUS, DELIVERABLE_TYPE, INVESTMENT_CATEGORY, REPORT_SCOPE } from "@/lib/labels";
import { compare } from "@/lib/metrics";
import type { ReportText } from "@/components/reports/report-document";
import type { ReportData, ReportFinancials } from "@/server/services/reports";

/**
 * PDF do relatório (react-pdf, sem navegador headless — compatível com
 * serverless). Fontes padrão (Helvetica) cobrem os acentos do português.
 */
function styles(brand: string) {
  return StyleSheet.create({
    page: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 44, fontSize: 9.5, fontFamily: "Helvetica", color: "#0f172a", lineHeight: 1.4 },
    brandBar: { position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: brand },
    header: { marginBottom: 18 },
    eyebrow: { fontSize: 8, color: brand, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontFamily: "Helvetica-Bold" },
    title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 8 },
    meta: { fontSize: 9, color: "#475569", marginBottom: 2 },
    section: { marginTop: 16 },
    h2: { fontSize: 12.5, fontFamily: "Helvetica-Bold", marginBottom: 2, color: "#0f172a" },
    note: { fontSize: 8, color: "#64748b", marginBottom: 6 },
    row: { flexDirection: "row", gap: 8 },
    stat: { flex: 1, borderWidth: 0.75, borderColor: "#e3e7ef", borderRadius: 4, padding: 7, backgroundColor: "#f8fafc" },
    statLabel: { fontSize: 7.5, color: "#64748b" },
    statValue: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 2 },
    li: { flexDirection: "row", marginBottom: 2 },
    bullet: { width: 10, color: "#64748b" },
    muted: { color: "#64748b" },
    tableHead: { flexDirection: "row", borderBottomWidth: 0.75, borderColor: "#cfd6e3", paddingBottom: 3, marginBottom: 2, fontSize: 8, color: "#64748b", fontFamily: "Helvetica-Bold" },
    tr: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#e3e7ef", paddingVertical: 3 },
    box: { borderWidth: 0.75, borderColor: "#e3e7ef", borderRadius: 4, padding: 8, flex: 1 },
    boxTitle: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", color: "#64748b", marginBottom: 4 },
    barTrack: { height: 6, backgroundColor: "#eceff5", borderRadius: 3, marginTop: 3 },
    footer: { position: "absolute", bottom: 24, left: 44, right: 44, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: "#94a3b8" },
    demo: { color: "#b45309", fontFamily: "Helvetica-Bold", marginBottom: 6 },
  });
}

type S = ReturnType<typeof styles>;
const num = (v: number | null | undefined) => (v == null ? "indisponível" : formatNumber(v));

function Section({ s, n, title, note, children }: { s: S; n: number; title: string; note?: string; children: ReactNode }) {
  return (
    <View style={s.section} wrap>
      <View minPresenceAhead={60}>
        <Text style={s.h2}>{String(n).padStart(2, "0")}  {title}</Text>
        {note ? <Text style={s.note}>{note}</Text> : <View style={{ height: 4 }} />}
      </View>
      {children}
    </View>
  );
}

function Stat({ s, label, value }: { s: S; label: string; value: string }) {
  return <View style={s.stat}><Text style={s.statLabel}>{label}</Text><Text style={s.statValue}>{value}</Text></View>;
}

function Bullets({ s, items }: { s: S; items: string[] }) {
  return <View>{items.map((t, i) => <View key={i} style={s.li}><Text style={s.bullet}>•</Text><Text style={{ flex: 1 }}>{t}</Text></View>)}</View>;
}

function Table({ s, cols, rows }: { s: S; cols: Array<{ label: string; flex: number; right?: boolean }>; rows: string[][] }) {
  return (
    <View>
      <View style={s.tableHead} fixed>{cols.map((c) => <Text key={c.label} style={{ flex: c.flex, textAlign: c.right ? "right" : "left" }}>{c.label}</Text>)}</View>
      {rows.map((r, i) => (
        <View key={i} style={s.tr} wrap={false}>{r.map((cell, j) => <Text key={j} style={{ flex: cols[j]!.flex, textAlign: cols[j]!.right ? "right" : "left" }}>{cell}</Text>)}</View>
      ))}
    </View>
  );
}

export function ReportPdf({ data, financials, text, brand, investmentRestricted }: { data: ReportData; financials: ReportFinancials | null; text: ReportText; brand: { name: string; organization: string; primaryColor: string }; investmentRestricted: boolean }) {
  const s = styles(brand.primaryColor);
  const p = data.params;
  const subject = data.subject.campaignName ?? data.subject.eventName ?? data.subject.ministryName ?? "Consolidado da agência";
  let i = 0;
  const comparisons: string[][] = [
    ["Demandas concluídas", formatNumber(data.operational.tasksCompleted), data.operational.tasksCompletedChange.reason === "no_previous" ? "—" : formatNumber(data.operational.tasksCompleted - (data.operational.tasksCompletedChange.absolute ?? 0)), data.operational.tasksCompletedChange.percent == null ? "n/c" : formatPercent(data.operational.tasksCompletedChange.percent)],
    ["Entregáveis", formatNumber(data.operational.deliverablesProduced), formatNumber(data.operational.deliverablesProduced - (data.operational.deliverablesChange.absolute ?? 0)), data.operational.deliverablesChange.percent == null ? "n/c" : formatPercent(data.operational.deliverablesChange.percent)],
    ...([["Impressões (pago)", data.paid.impressions, data.paid.previous.impressions], ["Cliques (pago)", data.paid.clicks, data.paid.previous.clicks], ["Resultados (pago)", data.paid.results, data.paid.previous.results]] as const)
      .map(([l, c, pr]) => { const ch = compare(c, pr); return [l, c == null ? "—" : formatNumber(c), pr == null ? "—" : formatNumber(pr), ch.percent == null ? "n/c" : formatPercent(ch.percent)]; }),
    ...Object.entries(data.organic).map(([pl, o]) => { const ch = compare(o.engagement, o.previousEngagement); return [`Interações ${pl === "instagram" ? "Instagram" : "Facebook"}`, o.engagement == null ? "—" : formatNumber(o.engagement), o.previousEngagement == null ? "—" : formatNumber(o.previousEngagement), ch.percent == null ? "n/c" : formatPercent(ch.percent)]; }),
  ];

  return (
    <Document title={text.title} author={brand.name} subject={`Relatório — ${subject}`} creator={brand.name} producer={brand.name}>
      <Page size="A4" style={s.page} wrap>
        <View style={s.brandBar} fixed />
        <View style={s.footer} fixed>
          <Text>{brand.name} · {brand.organization}</Text>
          <Text render={({ pageNumber, totalPages }) => `${text.title.slice(0, 60)} · página ${pageNumber} de ${totalPages}`} />
        </View>

        <View style={s.header}>
          <Text style={s.eyebrow}>{REPORT_SCOPE[p.scopeType]} · prestação de contas</Text>
          {data.subject.isDemo ? <Text style={s.demo}>DADOS DE DEMONSTRAÇÃO — não representam resultados reais</Text> : null}
          <Text style={s.title}>{text.title}</Text>
          <Text style={s.meta}>Escopo: {subject}</Text>
          <Text style={s.meta}>Ministério(s): {data.subject.ministryNames.join(", ") || "—"}</Text>
          <Text style={s.meta}>Período de referência: {formatDate(p.start)} a {formatDate(p.end)} · Dados gerados em {formatDateTime(data.generatedAt)}</Text>
        </View>

        <Section s={s} n={++i} title="Objetivos">
          {text.objectives ? <Text>{text.objectives}</Text> : null}
          {data.objectives.map((o) => <Text key={o.label}><Text style={{ fontFamily: "Helvetica-Bold" }}>{o.label}: </Text>{o.text}</Text>)}
          {!text.objectives && !data.objectives.length ? <Text style={s.muted}>Objetivos não registrados.</Text> : null}
        </Section>

        <Section s={s} n={++i} title="Resumo executivo">
          <View style={s.row}>
            <View style={s.box}><Text style={s.boxTitle}>Resultados observados (automático)</Text><Bullets s={s} items={data.facts} /></View>
            <View style={s.box}><Text style={s.boxTitle}>Análise da agência (editorial)</Text><Text>{text.executiveSummary || "Sem análise registrada."}</Text></View>
          </View>
        </Section>

        <Section s={s} n={++i} title="Demandas concluídas" note="Concluídas no período, conforme a origem (Asana ou registro manual)">
          <View style={s.row}>
            <Stat s={s} label="Concluídas" value={formatNumber(data.operational.tasksCompleted)} />
            <Stat s={s} label="Em aberto (hoje)" value={formatNumber(data.operational.tasksOpen)} />
            <Stat s={s} label="Atrasadas (hoje)" value={formatNumber(data.operational.tasksOverdue)} />
            <Stat s={s} label="Campanhas ativas" value={formatNumber(data.operational.activeCampaigns)} />
          </View>
          {data.tasks.length ? (
            <View style={{ marginTop: 6 }}>
              <Table s={s} cols={[{ label: "Demanda", flex: 3 }, { label: "Campanha / ministério", flex: 2 }, { label: "Conclusão", flex: 1, right: true }]}
                rows={data.tasks.slice(0, 80).map((t) => [t.name, t.campaign ?? t.ministry, formatDate(t.completed_at)])} />
              {data.tasks.length > 80 ? <Text style={s.note}>+ {data.tasks.length - 80} demandas não listadas</Text> : null}
            </View>
          ) : <Text style={[s.muted, { marginTop: 6 }]}>Nenhuma demanda concluída no período.</Text>}
        </Section>

        <Section s={s} n={++i} title="Entregáveis" note="Aprovados ou entregues no período">
          {data.deliverables.length ? (
            <Table s={s} cols={[{ label: "Entregável", flex: 3 }, { label: "Tipo", flex: 1 }, { label: "Status", flex: 1 }, { label: "Data", flex: 1, right: true }]}
              rows={data.deliverables.map((d) => [d.title + (d.campaign ? ` (${d.campaign})` : ""), DELIVERABLE_TYPE[d.type] ?? d.type, DELIVERABLE_STATUS[d.status]?.label ?? d.status, formatDate(d.date)])} />
          ) : <Text style={s.muted}>Nenhum entregável no período.</Text>}
        </Section>

        <Section s={s} n={++i} title="Campanhas executadas">
          {data.campaigns.length ? (
            <Table s={s} cols={[{ label: "Campanha", flex: 3 }, { label: "Status", flex: 1.2 }, { label: "Período", flex: 1.6, right: true }]}
              rows={data.campaigns.map((c) => [`${c.name}${c.objective ? ` — ${c.objective.slice(0, 80)}` : ""}`, CAMPAIGN_STATUS[c.status]?.label ?? c.status, `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`])} />
          ) : <Text style={s.muted}>Nenhuma campanha com atividade no período.</Text>}
        </Section>

        <Section s={s} n={++i} title="Indicadores orgânicos" note="Valor mais recente de cada publicação. Alcance não é somado entre plataformas.">
          {Object.keys(data.organic).length ? (
            <View style={s.row}>
              {Object.entries(data.organic).map(([pl, o]) => (
                <View key={pl} style={s.box}>
                  <Text style={s.boxTitle}>{pl === "instagram" ? "Instagram" : "Facebook"} · {o.posts} publicações</Text>
                  <Text>Alcance (soma por publicação): {num(o.reach)}</Text>
                  <Text>Visualizações: {num(o.views)}</Text>
                  <Text>Interações: {num(o.engagement)}</Text>
                </View>
              ))}
            </View>
          ) : <Text style={s.muted}>Sem dados orgânicos para o escopo.</Text>}
          {data.topPosts.length ? (
            <View style={{ marginTop: 6 }}>
              <Text style={s.boxTitle}>Publicações de melhor desempenho</Text>
              <Bullets s={s} items={data.topPosts.map((t) => `${(t.caption ?? "(sem legenda)").slice(0, 100)} — ${t.platform}, ${formatDate(t.published_at)}, ${t.engagement == null ? "sem métrica" : `${formatNumber(t.engagement)} interações`}`)} />
            </View>
          ) : null}
        </Section>

        <Section s={s} n={++i} title="Indicadores pagos (Meta Ads)" note="Fornecidos pela Meta; CTR calculado pelo portal (cliques ÷ impressões × 100)">
          {data.paid.available || data.paid.impressions != null ? (
            <View style={s.row}>
              <Stat s={s} label="Impressões" value={num(data.paid.impressions)} />
              <Stat s={s} label="Alcance (não dedup.)" value={num(data.paid.reach)} />
              <Stat s={s} label="Cliques" value={num(data.paid.clicks)} />
              <Stat s={s} label="Resultados" value={num(data.paid.results)} />
              <Stat s={s} label="CTR" value={data.paid.ctr == null ? "indisponível" : formatPercent(data.paid.ctr)} />
            </View>
          ) : <Text style={s.muted}>Nenhuma conta de anúncios associada a este escopo.</Text>}
        </Section>

        <Section s={s} n={++i} title="Investimentos">
          {financials ? (
            <View>
              <View style={s.row}>
                <Stat s={s} label="Meta Ads (período)" value={financials.paidSpend == null ? "indisponível" : formatCurrency(financials.paidSpend, financials.currency)} />
                <Stat s={s} label="Lançamentos realizados" value={financials.realizedManual == null ? "—" : formatCurrency(financials.realizedManual)} />
                <Stat s={s} label="Planejado" value={financials.planned == null ? "—" : formatCurrency(financials.planned)} />
                <Stat s={s} label="Custo por resultado" value={financials.costPerResult == null ? "indisponível" : formatCurrency(financials.costPerResult, financials.currency)} />
              </View>
              {financials.items.length ? (
                <View style={{ marginTop: 6 }}>
                  <Table s={s} cols={[{ label: "Descrição", flex: 3 }, { label: "Tipo", flex: 1 }, { label: "Categoria", flex: 1.2 }, { label: "Valor", flex: 1.2, right: true }]}
                    rows={financials.items.map((it) => [`${it.description}${it.campaign ? ` (${it.campaign})` : ""}`, it.kind === "planned" ? "Planejado" : "Realizado", INVESTMENT_CATEGORY[it.category] ?? it.category, formatCurrency(it.amount)])} />
                </View>
              ) : null}
            </View>
          ) : <Text style={s.muted}>{investmentRestricted ? "Seção restrita ao perfil do leitor." : "Sem informações de investimento."}</Text>}
        </Section>

        <Section s={s} n={++i} title="Comparativos" note="Período atual versus o período anterior de mesma duração (n/c = não comparável)">
          <Table s={s} cols={[{ label: "Indicador", flex: 3 }, { label: "Atual", flex: 1, right: true }, { label: "Anterior", flex: 1, right: true }, { label: "Variação", flex: 1, right: true }]} rows={comparisons} />
        </Section>

        <Section s={s} n={++i} title="Metas versus resultados">
          {data.goals.length ? data.goals.map((g, k) => (
            <View key={k} style={{ marginBottom: 6 }} wrap={false}>
              <Text><Text style={{ fontFamily: "Helvetica-Bold" }}>{g.label}</Text> — meta {formatMetric(g.target, g.unit)} · realizado {g.actual == null ? "—" : formatMetric(g.actual, g.unit)} · {g.progress == null ? "progresso indisponível" : formatPercent(g.progress, 0)}</Text>
              <View style={s.barTrack}><View style={{ height: 6, borderRadius: 3, backgroundColor: brand.primaryColor, width: `${Math.min(100, g.progress ?? 0)}%` }} /></View>
              <Text style={s.note}>{g.campaign} · fonte: {g.actualSource}</Text>
            </View>
          )) : <Text style={s.muted}>Nenhuma meta definida.</Text>}
          {data.eventResults.length ? (
            <View style={{ marginTop: 4 }}>
              <Text style={s.boxTitle}>Resultados do evento (com fonte declarada)</Text>
              <Bullets s={s} items={data.eventResults.map((r) => `${r.label}: ${r.value == null ? "—" : formatMetric(r.value, r.unit)} — fonte: ${r.source}`)} />
            </View>
          ) : null}
        </Section>

        <Section s={s} n={++i} title="Aprendizados">
          <Text>{[text.learnings, ...data.notes.learnings].filter(Boolean).join("\n\n") || "Sem aprendizados registrados."}</Text>
        </Section>
        <Section s={s} n={++i} title="Observações">
          <Text>{[text.observations, ...data.notes.observations].filter(Boolean).join("\n\n") || "Sem observações."}</Text>
        </Section>

        <Section s={s} n={++i} title="Fontes e atualização">
          <Bullets s={s} items={data.sources.map((src) => `${src.label}: ${src.status}${src.lastUpdate ? ` (atualizado em ${formatDateTime(src.lastUpdate)})` : ""}`)} />
          <Text style={[s.note, { marginTop: 6 }]}>Resultados observados são dados informados pelas fontes; metas são definidas pela equipe; análises são interpretações editoriais. A coincidência temporal entre entregas e resultados não estabelece relação causal.</Text>
        </Section>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(props: Parameters<typeof ReportPdf>[0]): Promise<Buffer> {
  return renderToBuffer(<ReportPdf {...props} />);
}
