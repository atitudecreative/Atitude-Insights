import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, PlugZap } from "lucide-react";
import { ActionForm } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { INTEGRATION_STATUS } from "@/lib/labels";
import { param, type RawSearch } from "@/lib/search";
import { requireSuperadmin } from "@/server/auth/current";
import { providerEnvStatus } from "@/server/services/admin";
import { listIntegrationAccounts, oauthRedirectUri, providerStatus, type IntegrationAccount } from "@/server/services/integrations-admin";
import { META_TOKEN_RENEWAL_WARNING_DAYS } from "@/server/integrations/meta/service";
import { connectTokenAction } from "../actions";
import { AccountActions } from "./account-actions";

export const metadata: Metadata = { title: "Integrações" };

const OK_MESSAGES: Record<string, string> = {
  asana: "Conta do Asana conectada. A descoberta de projetos foi enfileirada.",
  meta: "Conta da Meta conectada. A descoberta de ativos foi enfileirada.",
};
const ERROR_MESSAGES: Record<string, string> = {
  estado: "A autorização expirou ou não foi iniciada nesta sessão. Tente conectar novamente.",
  config: "OAuth não configurado no servidor.",
  negado: "A autorização foi cancelada no provedor.",
  falha: "Não foi possível concluir a conexão com o provedor. Tente novamente ou use um token.",
};

function ExpiryInfo({ a }: { a: IntegrationAccount }) {
  if (a.provider !== "meta") return a.token_expires_at ? <>Token renovado automaticamente</> : <>Token sem expiração</>;
  if (a.days_remaining == null) return <>Token sem data de expiração</>;
  if (a.days_remaining < 0) return <span className="text-danger">Token expirado em {formatDate(a.token_expires_at)}</span>;
  const warn = a.days_remaining <= META_TOKEN_RENEWAL_WARNING_DAYS;
  return <span className={warn ? "font-medium text-warning" : undefined}>Token expira em {a.days_remaining} dia(s){warn ? " — reconecte em breve" : ""}</span>;
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireSuperadmin();
  const sp = await searchParams;
  const accounts = await listIntegrationAccounts(actor);
  const env = providerEnvStatus();
  const ok = param(sp, "ok");
  const erro = param(sp, "erro");

  const providers = [
    {
      key: "asana" as const, name: "Asana", description: "Demandas (tarefas), seções, tags e campos personalizados dos projetos.",
      oauth: env.asana.oauthConfigured, oauthMissing: "ASANA_CLIENT_ID / ASANA_CLIENT_SECRET",
      tokenLabel: "Personal Access Token", tokenHint: "Asana → Configurações → Apps → Tokens de acesso pessoal. Leitura dos projetos que o usuário enxerga.",
    },
    {
      key: "meta" as const, name: "Meta", description: "Meta Ads (campanhas e métricas pagas), Instagram e Páginas do Facebook (orgânico).",
      oauth: env.meta.appConfigured, oauthMissing: "META_APP_ID / META_APP_SECRET",
      tokenLabel: "Token de Usuário do Sistema", tokenHint: "Business Manager → Usuários do sistema → Gerar token (ads_read, pages_read_engagement, read_insights, instagram_basic, instagram_manage_insights).",
    },
  ];

  return (
    <>
      <PageHeader title="Integrações" description="Contas conectadas ao Asana e à Meta. Credenciais ficam cifradas no servidor e nunca são exibidas."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Integrações" }]} />
      {ok && OK_MESSAGES[ok] ? <p role="status" className="mb-4 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{OK_MESSAGES[ok]}</p> : null}
      {erro ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{ERROR_MESSAGES[erro] ?? ERROR_MESSAGES.falha}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((p) => {
          const status = providerStatus(p.key, accounts);
          return (
            <Card key={p.key}>
              <CardHeader title={p.name} description={p.description} action={<StatusBadge map={INTEGRATION_STATUS} value={status} />} />
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">Conectar com OAuth</p>
                  {p.oauth ? (
                    <form action={`/api/integrations/${p.key}/start`} method="get" className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <Field label="Nome da conexão" htmlFor={`oauth-label-${p.key}`} className="min-w-0 flex-1">
                        <Input id={`oauth-label-${p.key}`} name="label" maxLength={120} placeholder={p.key === "asana" ? "Asana — Agência" : "Meta — Business Manager"} />
                      </Field>
                      <Button type="submit"><PlugZap /> Autorizar no {p.name}</Button>
                    </form>
                  ) : (
                    <p className="mt-1 text-xs text-subtle">
                      <Badge tone="muted">Não configurada</Badge> Defina {p.oauthMissing} no servidor para habilitar o login OAuth.
                      URI de redirecionamento: <code className="break-all font-mono">{oauthRedirectUri(p.key)}</code>
                    </p>
                  )}
                </div>
                <details className="rounded-lg border border-border p-3" open={!p.oauth}>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><KeyRound className="size-4 text-subtle" aria-hidden /> Conectar com {p.tokenLabel}</summary>
                  <ActionForm action={connectTokenAction.bind(null, p.key)} submitLabel="Validar e conectar" pendingLabel="Validando token…" className="mt-3">
                    <Field label="Nome da conexão" htmlFor={`label-${p.key}`}>
                      <Input id={`label-${p.key}`} name="label" maxLength={120} placeholder={p.key === "asana" ? "Asana — Agência" : "Meta — Usuário do Sistema"} />
                    </Field>
                    <Field label={p.tokenLabel} htmlFor={`token-${p.key}`} hint={p.tokenHint} required>
                      <Input id={`token-${p.key}`} name="token" type="password" required autoComplete="off" spellCheck={false} />
                    </Field>
                    <p className="text-xs text-subtle">O token é validado antes de ser salvo; tokens inválidos nunca são armazenados.</p>
                  </ActionForm>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <h2 className="mt-8 mb-3 text-[15px] font-semibold tracking-tight">Contas conectadas</h2>
      {accounts.length ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {accounts.map((a) => (
            <li key={a.id}>
              <Card className="h-full">
                <CardHeader
                  title={<Link href={`/admin/integracoes/${a.id}`} className="hover:text-brand">{a.label}</Link>}
                  description={<>{a.provider === "asana" ? "Asana" : "Meta"} · {a.auth_type === "oauth" ? "OAuth" : "Token"}{a.external_user_name ? ` · ${a.external_user_name}` : ""}</>}
                  action={<span className="flex flex-wrap gap-1">{a.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}<StatusBadge map={INTEGRATION_STATUS} value={a.status} /></span>} />
                <CardContent className="space-y-3">
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs text-subtle">Último teste</dt><dd title={formatDateTime(a.last_tested_at)}>
                      {a.last_tested_at ? <>{a.last_test_ok ? <span className="text-success">OK</span> : <span className="text-danger">Falhou</span>} · {formatRelative(a.last_tested_at)}</> : "Nunca"}</dd></div>
                    <div><dt className="text-xs text-subtle">Última sincronização</dt><dd title={formatDateTime(a.last_sync_at)}>{formatRelative(a.last_sync_at)}{a.active_jobs ? <span className="block text-xs text-info">{a.active_jobs} job(s) em andamento</span> : null}</dd></div>
                    <div><dt className="text-xs text-subtle">Ativos</dt><dd>{a.assets_enabled} de {a.assets} sincronizando</dd></div>
                    <div><dt className="text-xs text-subtle">Credencial</dt><dd className="text-xs"><ExpiryInfo a={a} /></dd></div>
                  </dl>
                  {a.last_error && a.status !== "connected" ? <p className="break-words rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{a.last_error}</p> : null}
                  {!a.sync_enabled && a.status !== "disconnected" && !a.is_demo ? <p className="text-xs text-warning">Sincronização agendada pausada nesta conta.</p> : null}
                  <AccountActions accountId={a.id} provider={a.provider} disabled={a.status === "disconnected"} isDemo={a.is_demo} compact />
                  <Link href={`/admin/integracoes/${a.id}`} className="inline-block text-sm font-medium text-brand hover:underline">Ativos, associações e regras →</Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : <EmptyState icon={PlugZap} title="Nenhuma conta conectada" description="Conecte o Asana e a Meta acima para começar a sincronizar demandas e métricas." />}
    </>
  );
}
