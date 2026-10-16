import type { Metadata } from "next";
import Link from "next/link";
import { Building2, FlaskConical, Inbox, PlugZap, RefreshCw, ScrollText, Settings, TriangleAlert, Users } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/metric";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";
import { INTEGRATION_STATUS, SYNC_JOB_TYPE } from "@/lib/labels";
import { metric } from "@/lib/metrics";
import { requireSuperadmin } from "@/server/auth/current";
import { getAdminOverview } from "@/server/services/admin";

export const metadata: Metadata = { title: "Administração" };

const LINKS = [
  { href: "/admin/ministerios", label: "Ministérios", description: "Cadastro, arquivamento, membros e ativos", icon: Building2 },
  { href: "/admin/usuarios", label: "Usuários e convites", description: "Convites, papéis, vínculos e sessões", icon: Users },
  { href: "/admin/integracoes", label: "Integrações", description: "Asana e Meta: conexão, ativos e regras", icon: PlugZap },
  { href: "/admin/sincronizacoes", label: "Sincronizações", description: "Histórico, falhas e agenda", icon: RefreshCw },
  { href: "/admin/auditoria", label: "Auditoria", description: "Registro de ações administrativas", icon: ScrollText },
  { href: "/admin/configuracoes", label: "Configurações", description: "Identidade visual e dados de demonstração", icon: Settings },
];

export default async function AdminPage() {
  const actor = await requireSuperadmin();
  const data = await getAdminOverview(actor);
  const c = data.counts;
  const unclassified = c.unclassified_tasks + c.unclassified_campaigns + c.unclassified_posts;
  const byProvider = (provider: string) => data.accounts.filter((a) => a.provider === provider && a.status !== "disconnected");
  const providers = [
    { key: "asana", name: "Asana", envOk: data.env.asana.oauthConfigured, envLabel: "OAuth (ASANA_CLIENT_ID/SECRET)", fallback: "Token pessoal disponível mesmo sem OAuth." },
    { key: "meta", name: "Meta (Facebook, Instagram e Ads)", envOk: data.env.meta.appConfigured, envLabel: "App da Meta (META_APP_ID/SECRET)", fallback: "Token de Usuário do Sistema disponível mesmo sem o app." },
  ];

  return (
    <>
      <PageHeader title="Visão administrativa" description="Saúde da plataforma: cadastros, acessos, integrações e sincronizações." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Ministérios ativos" value={metric.value(c.ministries_active)} icon={Building2} href="/admin/ministerios"
          hint={c.ministries_archived ? `${c.ministries_archived} arquivado(s)` : undefined} />
        <KpiCard label="Usuários ativos" value={metric.value(c.users_active)} icon={Users} href="/admin/usuarios"
          hint={c.invitations_pending ? `${c.invitations_pending} convite(s) pendente(s)` : undefined} />
        <KpiCard label="Contas conectadas" value={metric.value(data.accounts.filter((a) => a.status !== "disconnected").reduce((s, a) => s + a.n, 0))} icon={PlugZap} href="/admin/integracoes" />
        <KpiCard label="Itens não classificados" value={metric.value(unclassified)} icon={Inbox} href="/classificacao"
          hint={`${c.unclassified_tasks} demandas · ${c.unclassified_campaigns + c.unclassified_posts} da Meta`} />
        <KpiCard label="Falhas de sincronização (24 h)" value={metric.value(c.failed_jobs_24h)} icon={TriangleAlert} href="/admin/sincronizacoes?status=failed"
          hint={c.running_jobs ? `${c.running_jobs} em execução/fila` : undefined} className="col-span-2 lg:col-span-1" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Integrações" description="Configuração do servidor e estado das contas conectadas" action={<Link href="/admin/integracoes" className="text-sm font-medium text-brand hover:underline">Gerenciar</Link>} />
          <CardContent className="grid gap-3 md:grid-cols-2">
            {providers.map((p) => {
              const accounts = byProvider(p.key);
              return (
                <div key={p.key} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{p.name}</p>
                    {accounts.length ? null : <StatusBadge map={INTEGRATION_STATUS} value="not_configured" />}
                  </div>
                  <p className="mt-2 text-xs text-subtle">
                    {p.envLabel}: {p.envOk ? <span className="font-medium text-success">configurado</span> : <span className="font-medium text-warning">Não configurada</span>}
                  </p>
                  {!p.envOk ? <p className="mt-1 text-xs text-subtle">{p.fallback}</p> : null}
                  {accounts.length ? (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {accounts.map((a) => (
                        <li key={a.status} className="flex items-center gap-1.5 text-sm">
                          <StatusBadge map={INTEGRATION_STATUS} value={a.status} /><span className="tabular text-muted">× {a.n}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Falhas recentes" action={<Link href="/admin/sincronizacoes?status=failed" className="text-sm font-medium text-brand hover:underline">Ver todas</Link>} />
          <CardContent>
            {data.recentFailures.length ? (
              <ul className="space-y-3">
                {data.recentFailures.map((j) => (
                  <li key={j.id} className="min-w-0 text-sm">
                    <Link href={`/admin/sincronizacoes/${j.id}`} className="font-medium hover:text-brand">{SYNC_JOB_TYPE[j.job_type] ?? j.job_type}</Link>
                    <p className="text-xs text-subtle">{j.label ?? "Conta removida"} · {formatDateTime(j.finished_at)}</p>
                    {j.error ? <p className="mt-0.5 line-clamp-2 break-words text-xs text-danger">{j.error}</p> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-subtle">Nenhuma falha registrada.</p>}
          </CardContent>
        </Card>
      </div>

      <h2 className="mt-8 mb-3 text-[15px] font-semibold tracking-tight">Atalhos</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex items-start gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-border-strong hover:bg-surface-muted/40">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><l.icon className="size-4" aria-hidden /></span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{l.label}</span>
                <span className="block text-xs text-subtle">{l.description}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {c.ministries_demo ? (
        <p className="mt-6 flex items-center gap-2 text-xs text-subtle">
          <FlaskConical className="size-3.5" aria-hidden /> {c.ministries_demo} ministério(s) de demonstração carregado(s) — <Badge tone="warning">isolados do modo produção</Badge>
          <Link href="/admin/configuracoes" className="text-brand hover:underline">Gerenciar</Link>
        </p>
      ) : null}
    </>
  );
}
