# Banco de dados

PostgreSQL ≥ 14 (testado em 16). Todas as tabelas no schema `app`. Migrações em
`db/migrations` (aplicar com `npm run db:migrate`); tipos gerados em
`src/server/db/schema.generated.ts` (`npm run db:types`).

## Hierarquia

```
ministries ─┬─ ministry_memberships ── users ── sessions
            ├─ campaigns ─┬─ campaign_channels ── channels
            │             ├─ campaign_responsibles ── users
            │             ├─ campaign_events ── events ─┬─ event_responsibles
            │             ├─ campaign_goals              └─ event_results
            │             ├─ campaign_external_campaigns ── external_campaigns ─ external_ad_sets ─ external_ads
            │             └─ campaign_social_posts ── social_posts
            ├─ tasks (Asana/manual) ── deliverables ── deliverable_comments
            ├─ investments (planned / realized)
            ├─ reports ── report_versions ── report_version_financials
            └─ metric_observations ── metric_definitions

connected_accounts ── external_assets ─┬─ asset_ministry_mappings ── ministries
                                       ├─ metric_availability
                                       └─ (external_campaigns, social_posts, metric_observations)
mapping_rules ── ministries / campaigns / events
sync_jobs ── sync_logs
activity_logs · app_settings · invitations · oauth_states · rate_limits
```

## Tabelas

| Tabela | Descrição | Pontos de integridade |
|---|---|---|
| `users` | usuários (perfil incorporado: nome, avatar) | e-mail único (minúsculo) entre não excluídos; `agency_global_access` só para agência; exclusão lógica |
| `sessions` | sessões opacas (hash do token) | sem acesso pelo papel da aplicação |
| `invitations` | convites e redefinições de senha | token como hash, uso único, expiração |
| `ministries` | ministérios/departamentos | `slug` único; `status` ativo/arquivado; `is_demo` |
| `ministry_memberships` | vínculo explícito usuário ⇄ ministério | único por par; gatilho valida papel × perfil global |
| `channels` | canais de comunicação (semeados) | `key` única |
| `campaigns` | campanha de comunicação | datas coerentes; ministério imutável |
| `events` | eventos com período de divulgação e links | datas coerentes; ministério imutável |
| `campaign_events` | N:N campanha ⇄ evento | mesmo ministério (gatilho) |
| `event_results` | resultados pós-evento | **fonte obrigatória** |
| `tasks` | demandas (Asana ou manuais) | único por `(source, external_id)`; vínculos do mesmo ministério; campos do Asana protegidos |
| `deliverables` / `deliverable_comments` | entregáveis e comentários | vínculos do mesmo ministério |
| `investments` | planejado/realizado | valor ≥ 0; visibilidade por permissão de investimento |
| `campaign_goals` | metas | realizado manual exige fonte |
| `connected_accounts` | contas Asana/Meta | credenciais cifradas, sem GRANT à aplicação |
| `external_assets` | workspaces, projetos, contas de anúncio, páginas, perfis | único por `(provider, asset_type, external_id)` |
| `asset_ministry_mappings` | ativo ⇄ ministério (N:N) | único por par |
| `mapping_rules` | regras de classificação | únicas por combinação |
| `external_campaigns`/`external_ad_sets`/`external_ads` | entidades nativas da Meta | únicas por ID externo; ministério propagado às filhas |
| `social_posts` | publicações orgânicas | únicas por `(platform, external_id)` |
| `metric_definitions` | catálogo (fornecida × derivada, aditividade, monetária) | — |
| `metric_observations` | série histórica | chave natural única → *upsert* idempotente |
| `metric_availability` | métricas disponíveis por ativo/tipo de mídia | única por `(ativo, métrica, escopo)` |
| `reports`/`report_versions`/`report_version_financials` | relatórios e versões congeladas | escopo coerente; financeiro separado |
| `sync_jobs`/`sync_logs` | fila e logs | um job ativo por conta/tipo |
| `activity_logs` | auditoria e histórico | *append-only* via `app.log_activity` |
| `app_settings` | identidade visual, agenda de sincronização, manutenção | — |
| `rate_limits` / `oauth_states` | limites de tentativa e estados OAuth | somente sistema |

## Retenção histórica

* Métricas diárias de anúncios são re-coletadas nos últimos 28 dias (revisões
  de atribuição da Meta) e mantidas indefinidamente.
* Métricas de publicações geram um *snapshot* por dia de coleta
  (`granularity = 'lifetime'`, `period_end` = data da coleta), preservando a
  evolução.
* Rotinas de limpeza (logs, sessões, convites) em `src/server/integrations/maintenance.ts`
  e `docs/lgpd.md`.

## Dados de demonstração

Somente em ministérios `is_demo = true` (prefixo `[DEMO]`, slug `demo-…`) e
uma conta conectada "[DEMO]" sem credenciais. Carregar/remover em
Administração → Configurações.
