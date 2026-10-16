import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Database, ListTree, Workflow } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { ToggleForm } from "@/components/admin/toggle-form";
import { ActionForm } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { ASSET_TYPE, INTEGRATION_STATUS } from "@/lib/labels";
import { param, type RawSearch } from "@/lib/search";
import { requireSuperadmin } from "@/server/auth/current";
import { asanaProjectStructure, getIntegrationAccount } from "@/server/services/integrations-admin";
import {
  addAssetMappingAction, assetSyncAction, deleteMappingRuleAction, removeAssetMappingAction, runSyncAction, saveMappingRuleAction, toggleMappingRuleAction,
  updateAccountAction,
} from "../../actions";
import { AccountActions } from "../account-actions";
import { RuleForm, type ProjectStructure } from "./rule-form";

export const metadata: Metadata = { title: "Conta conectada" };

const RULE_TYPE: Record<string, string> = {
  asana_project: "Projeto", asana_section: "Seção", asana_tag: "Tag", asana_custom_field: "Campo personalizado", meta_campaign_name_prefix: "Prefixo do nome",
};

export default async function IntegrationAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearch> }) {
  const actor = await requireSuperadmin();
  const { id } = await params;
  const sp = await searchParams;
  const data = await getIntegrationAccount(actor, id);
  if (!data) notFound();
  const { account: a, assets, mappings, availability, rules, ministries, campaigns, events } = data;
  const path = `/admin/integracoes/${id}`;
  const projectId = param(sp, "projeto");
  const projects = assets.filter((x) => x.asset_type === "asana_project" && !x.removed_at);
  const live = a.provider === "asana" && projectId && projects.some((p) => p.id === projectId) ? await asanaProjectStructure(actor, id, projectId) : null;
  const structure: ProjectStructure | null = live?.ok ? {
    projectAssetId: projectId!,
    sections: live.sections.map((s) => ({ gid: s.gid, name: s.name })),
    customFields: live.customFields.map((f) => ({
      gid: f.custom_field.gid, name: f.custom_field.name,
      options: (f.custom_field.enum_options ?? []).filter((o) => o.enabled !== false).map((o) => ({ gid: o.gid, name: o.name })),
    })),
  } : null;

  const activeMinistries = ministries.filter((m) => m.status === "active");
  // Dados reais e de demonstração nunca se misturam (validado também no serviço).
  const mappable = activeMinistries.filter((m) => m.is_demo === a.is_demo);
  const ruleTargets = activeMinistries.filter((m) => !m.is_demo);
  const types = [...new Set(assets.map((x) => x.asset_type))];
  const ruleAssets = a.provider === "asana" ? projects : assets.filter((x) => x.asset_type === "meta_ad_account" && !x.removed_at);
  const assetName = new Map(assets.map((x) => [x.id, x.name]));

  const assetsTab = (
    <div className="space-y-4">
      <p className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
        Itens de um ativo (tarefas, campanhas, publicações) são classificados automaticamente somente quando o ativo está associado a <strong>exatamente um</strong> ministério.
        Com vários ministérios, use regras de classificação; sem regra aplicável, os itens vão para a fila de <Link href="/classificacao" className="underline">itens não classificados</Link>.
      </p>
      {types.length ? types.map((t) => (
        <Card key={t}>
          <CardHeader title={ASSET_TYPE[t] ?? t} description={`${assets.filter((x) => x.asset_type === t).length} ativo(s)`} />
          <ul className="divide-y divide-border border-t border-border">
            {assets.filter((x) => x.asset_type === t).map((x) => {
              const own = mappings.filter((m) => m.external_asset_id === x.id);
              return (
                <li key={x.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{x.name}</p>
                    <p className="break-all text-xs text-subtle">ID externo {x.external_id} · {x.last_synced_at ? `sincronizado ${formatRelative(x.last_synced_at)}` : "nunca sincronizado"}</p>
                    {x.removed_at ? <Badge tone="muted" className="mt-1">Removido na origem em {formatDate(x.removed_at)}</Badge> : (
                      <div className="mt-2">
                        <ToggleForm action={assetSyncAction} checked={x.sync_enabled} label="Sincronizar este ativo" hidden={{ assetId: x.id, accountId: id }} disabled={a.is_demo} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 space-y-2">
                    <p className="text-xs font-medium text-subtle">Ministérios associados</p>
                    {own.length ? (
                      <ul className="flex flex-wrap gap-2">
                        {own.map((m) => (
                          <li key={m.id} className="flex items-center gap-1 rounded-full border border-border bg-surface-muted py-0.5 pr-1 pl-3 text-xs">
                            {m.ministry_name}
                            <ActionButton action={removeAssetMappingAction.bind(null, path)} hidden={{ mappingId: m.id }} label="×" variant="ghost" size="icon-sm"
                              className="space-y-0" confirm={`Remover a associação com ${m.ministry_name}?`} />
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-xs text-warning">Sem associação — itens deste ativo ficam não classificados (salvo regras).</p>}
                    {own.length > 1 ? <p className="text-xs text-warning">Vários ministérios: a classificação automática por ativo não se aplica.</p> : null}
                    <ActionForm action={addAssetMappingAction.bind(null, path)} submitLabel="Associar" inline>
                      <input type="hidden" name="assetId" value={x.id} />
                      <label className="sr-only" htmlFor={`map-${x.id}`}>Ministério para {x.name}</label>
                      <Select id={`map-${x.id}`} name="ministryId" required defaultValue="" className="h-9 w-auto min-w-0 flex-1 text-sm">
                        <option value="" disabled>Associar a ministério…</option>
                        {mappable.filter((m) => !own.some((o) => o.ministry_id === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </Select>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )) : <EmptyState icon={Database} title="Nenhum ativo descoberto" description="Use “Descobrir ativos” para listar projetos, contas de anúncios e perfis disponíveis para este token." />}
    </div>
  );

  const metricsTab = availability.length ? (
    <Card>
      <CardHeader title="Disponibilidade de métricas" description="Registrada pela sincronização: a API varia por conta, tipo de ativo e permissão." />
      <DataTable caption="Disponibilidade de métricas" rows={availability} rowKey={(r) => r.id}
        columns={[
          { key: "asset", header: "Ativo", cell: (r) => assetName.get(r.external_asset_id) ?? "—" },
          { key: "metric", header: "Métrica", cell: (r) => <span className="font-mono text-xs">{r.metric_key}{r.scope !== "default" ? ` (${r.scope})` : ""}</span> },
          { key: "available", header: "Disponível", cell: (r) => r.available ? <Badge tone="success">Sim</Badge> : <Badge tone="muted">Não</Badge> },
          { key: "reason", header: "Motivo", cell: (r) => <span className="text-xs text-subtle">{r.reason ?? "—"}</span> },
          { key: "checked", header: "Verificado", cell: (r) => <span className="text-xs">{formatRelative(r.checked_at)}</span> },
        ]} />
    </Card>
  ) : <EmptyState icon={ListTree} title="Sem informações de disponibilidade" description="As métricas disponíveis são registradas na primeira sincronização de cada ativo." />;

  const rulesTab = (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="min-w-0 xl:col-span-3">
        <CardHeader title={`Regras de classificação — ${a.provider === "asana" ? "Asana" : "Meta"}`}
          description="Regras explícitas têm precedência sobre a associação de ativos. Empate de prioridade entre ministérios diferentes envia o item para revisão."
          action={a.is_demo ? null : <ActionButton action={runSyncAction} hidden={{ accountId: id, kind: "reclassify" }} label="Reclassificar" pendingLabel="Reclassificando…" />} />
        <DataTable caption="Regras" rows={rules} rowKey={(r) => r.id}
          empty={<div className="px-5 pb-5"><EmptyState compact icon={Workflow} title="Nenhuma regra cadastrada" /></div>}
          columns={[
            { key: "rule", header: "Regra", cell: (r) => (
              <span className="text-sm">{RULE_TYPE[r.rule_type] ?? r.rule_type}
                <span className="block break-all text-xs text-subtle">
                  {r.asset_name ? `${r.asset_name}` : "Qualquer ativo"}{r.match_field ? ` · campo ${r.match_field}` : ""}{r.match_value ? ` · “${r.match_value}”` : ""}
                </span></span>) },
            { key: "target", header: "Destino", cell: (r) => (
              <span className="text-sm">{r.ministry_name}
                {r.campaign_name || r.event_name ? <span className="block text-xs text-subtle">{[r.campaign_name, r.event_name].filter(Boolean).join(" · ")}</span> : null}</span>) },
            { key: "priority", header: "Prioridade", align: "right", cell: (r) => r.priority },
            { key: "active", header: "Ativa", cell: (r) => <ToggleForm action={toggleMappingRuleAction.bind(null, id)} checked={r.active} label={r.active ? "Sim" : "Não"} hidden={{ ruleId: r.id }} /> },
            { key: "remove", header: <span className="sr-only">Remover</span>, mobileLabel: "Ações", align: "right", cell: (r) => (
              <ActionButton action={deleteMappingRuleAction.bind(null, id)} hidden={{ ruleId: r.id }} label="Remover" variant="danger-ghost" confirm="Remover esta regra?" />) },
          ]} />
      </Card>
      <Card className="min-w-0 xl:col-span-2">
        <CardHeader title="Nova regra" />
        <CardContent className="space-y-4">
          {a.provider === "asana" ? (
            <form method="get" className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
              <Field label="Carregar seções e campos do projeto" htmlFor="projeto" className="min-w-0 flex-1" hint="Consulta o Asana ao vivo com a credencial da conta.">
                <Select id="projeto" name="projeto" defaultValue={projectId ?? ""}>
                  <option value="">Selecione um projeto…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Button type="submit" variant="secondary" className="sm:mb-5">Carregar</Button>
            </form>
          ) : null}
          {live && !live.ok ? <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{live.message}</p> : null}
          {structure ? <p className="text-xs text-success">{structure.sections.length} seção(ões) e {structure.customFields.length} campo(s) personalizado(s) carregados.</p> : null}
          <RuleForm key={projectId ?? "none"} action={saveMappingRuleAction.bind(null, id, null)} provider={a.provider as "asana" | "meta"}
            assets={ruleAssets.map((x) => ({ id: x.id, name: x.name }))} ministries={ruleTargets.map((m) => ({ id: m.id, name: m.name }))}
            campaigns={campaigns} events={events} structure={structure} />
        </CardContent>
      </Card>
    </div>
  );

  const settingsTab = (
    <Card className="max-w-2xl">
      <CardHeader title="Configurações da conta" description="O token nunca é exibido. Para trocá-lo, desconecte e conecte novamente." />
      <CardContent>
        <ActionForm action={updateAccountAction.bind(null, id)} submitLabel="Salvar" resetOnSuccess={false}>
          <Field label="Nome da conexão" htmlFor="acc-label"><Input id="acc-label" name="label" defaultValue={a.label} required minLength={2} maxLength={120} /></Field>
          <Checkbox name="syncEnabled" defaultChecked={a.sync_enabled} disabled={a.is_demo} label="Sincronização agendada ativa"
            description="Quando desativada, a conta só sincroniza manualmente." />
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-subtle">Autenticação</dt><dd>{a.auth_type === "oauth" ? "OAuth" : "Token"}</dd></div>
            <div><dt className="text-xs text-subtle">Usuário no provedor</dt><dd>{a.external_user_name ?? "—"}</dd></div>
            <div><dt className="text-xs text-subtle">Conectada em</dt><dd>{formatDateTime(a.created_at)}</dd></div>
            <div><dt className="text-xs text-subtle">Expiração do token</dt><dd>{a.token_expires_at ? `${formatDate(a.token_expires_at)}${a.days_remaining != null ? ` (${a.days_remaining} dia(s))` : ""}` : "Sem expiração registrada"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-subtle">Permissões concedidas</dt><dd className="mt-1 flex flex-wrap gap-1">{a.scopes.length ? a.scopes.map((s) => <Badge key={s}>{s}</Badge>) : "—"}</dd></div>
          </dl>
        </ActionForm>
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader title={a.label}
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Integrações", href: "/admin/integracoes" }, { label: a.label }]}
        eyebrow={<span className="flex flex-wrap gap-1"><Badge tone="brand">{a.provider === "asana" ? "Asana" : "Meta"}</Badge><StatusBadge map={INTEGRATION_STATUS} value={a.status} />{a.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}</span>}
        description={<>Último teste {a.last_tested_at ? `${formatRelative(a.last_tested_at)} (${a.last_test_ok ? "OK" : "falhou"})` : "nunca"} · última sincronização {formatRelative(a.last_sync_at)} · <Link className="text-brand hover:underline" href={`/admin/sincronizacoes?conta=${a.id}`}>histórico</Link></>} />
      {param(sp, "ok") === "conectada" ? <p role="status" className="mb-4 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">Conta conectada. A descoberta de ativos foi enfileirada — use “Descobrir ativos” para executá-la agora.</p> : null}
      {a.last_error && a.status !== "connected" ? <p role="alert" className="mb-4 break-words rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{a.last_error}</p> : null}
      <div className="mb-6"><AccountActions accountId={a.id} provider={a.provider} disabled={a.status === "disconnected"} isDemo={a.is_demo} /></div>
      <Tabs defaultValue={projectId ? "regras" : "ativos"} tabs={[
        { value: "ativos", label: `Ativos (${assets.length})`, content: assetsTab },
        { value: "regras", label: `Regras (${rules.length})`, content: rulesTab },
        { value: "metricas", label: "Métricas disponíveis", content: metricsTab },
        { value: "conta", label: "Configurações", content: settingsTab },
      ]} />
    </>
  );
}
