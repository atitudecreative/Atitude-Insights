# Arquitetura e decisões (ADR)

Este documento registra as decisões técnicas relevantes do Atitude Insights e o
porquê de cada uma. Novas decisões devem ser acrescentadas ao final.

## Visão geral

```
Navegador ──HTTPS──▶ Next.js (App Router, Node.js)
                       ├─ Server Components (leitura)  ─┐
                       ├─ Server Actions (mutações)     ├─▶ Serviços (src/server/services)
                       └─ Route Handlers (PDF, CSV,     ┘        │  withUserDb(userId)
                          OAuth, cron, health)                    ▼
                                                     PostgreSQL ── schema `app`
                                                       • papel restrito atitude_app + RLS
                                                       • funções SECURITY DEFINER de autorização
Agendador (Vercel Cron / worker) ─▶ /api/cron/sync ─▶ fila app.sync_jobs ─▶ Asana API / Meta Graph & Marketing API
```

Uma única aplicação multi-tenant lógica: todos os ministérios compartilham o
banco, e o isolamento é garantido no PostgreSQL (RLS) e revalidado no servidor.

## ADR-001 — Next.js (App Router) + TypeScript estrito como frontend e backend

* Um único projeto com Server Components, Server Actions e Route Handlers
  elimina uma API separada e mantém toda a lógica sensível no servidor.
* `strict`, `noUncheckedIndexedAccess` e `noImplicitOverride` ativos.
* Componentes de cliente apenas onde há interação (filtros, gráficos, formulários).

## ADR-002 — PostgreSQL com RLS como camada de autorização (compatível com Supabase)

* O banco é a fonte de verdade das permissões. Toda consulta originada por um
  usuário roda em uma transação com `SET LOCAL ROLE atitude_app` (papel sem
  `BYPASSRLS`) e `app.user_id` definido (`withUserDb`, `src/server/db/index.ts`).
* As políticas usam funções `SECURITY DEFINER` (`app.can_read_ministry`,
  `app.can_manage_ministry`, `app.can_view_investment`, `app.can_collaborate`,
  `app.has_global_read`...) que conferem **vínculo explícito** usuário ⇄ ministério
  e **status ativo** do usuário a cada consulta. Remover um vínculo ou desativar
  um usuário tem efeito imediato, mesmo para sessões já abertas.
* Colunas sensíveis (`password_hash`, `credentials_encrypted`, payloads `raw`)
  não são concedidas ao papel da aplicação: nem um superadministrador consegue
  lê-las pelo caminho de usuário.
* Tabelas em um schema próprio (`app`) — fora do schema `public` exposto pelo
  PostgREST do Supabase —, sem `GRANT` para `anon`/`authenticated`.
* **Por que não Supabase Auth + supabase-js no navegador?** Exigiria expor o
  banco via PostgREST e duplicar regras em JWT claims; o ambiente de
  desenvolvimento também precisaria de toda a stack do Supabase (GoTrue,
  PostgREST, Kong) para testes. Com RLS baseada em `app.user_id`, o mesmo
  código roda em Supabase (como banco gerenciado), Neon, RDS ou PostgreSQL
  local, e os testes de isolamento rodam contra um PostgreSQL real.

## ADR-003 — Autenticação própria com sessões opacas no banco

* Senhas com scrypt (N=2¹⁵, salt aleatório), comparação em tempo constante.
* Sessão = token aleatório de 256 bits em cookie `httpOnly`, `SameSite=Lax`,
  `Secure` em produção; no banco fica apenas o SHA-256 do token.
* Expiração por inatividade (padrão 72 h, deslizante) e absoluta (14 dias).
* Logout revoga a sessão no servidor; desativação/remoção de usuário revoga
  todas as sessões; troca de senha encerra sessões anteriores.
* Limite de tentativas de login persistido no PostgreSQL (funciona com várias
  instâncias/serverless).
* Convites e redefinições: token de uso único (hash no banco), validade de
  72 h / 24 h, bloqueio de linha no aceite. Sem serviço de e-mail obrigatório:
  o administrador copia o link (pode-se plugar SMTP depois).

## ADR-004 — Kysely + SQL versionado

* Migrações SQL escritas à mão (`db/migrations`) — RLS, funções e gatilhos
  exigem SQL explícito. O executor (`src/server/db/migrator.ts`) aplica cada
  arquivo em transação e guarda checksum (alteração de migração aplicada é erro).
* Tipos gerados a partir do banco real com `kysely-codegen`
  (`npm run db:types` → `src/server/db/schema.generated.ts`), garantindo
  tipagem consistente entre banco e aplicação.

## ADR-005 — Campanha de comunicação ≠ campanha publicitária da Meta

* `app.campaigns` é a campanha de comunicação do portal; `app.external_campaigns`,
  `external_ad_sets` e `external_ads` espelham as entidades nativas da Meta.
* Ligação explícita N:N (`campaign_external_campaigns`, `campaign_social_posts`),
  com gatilho que exige o mesmo ministério dos dois lados.

## ADR-006 — Classificação de itens externos: regras explícitas, nunca por nome

* Ordem: regras de mapeamento do administrador (projeto, seção, tag, campo
  personalizado do Asana; prefixo de nome configurado para a Meta) por
  prioridade → vínculo ativo ⇄ ministério **apenas quando o ativo aponta para um
  único ministério** → fila de revisão manual (`/classificacao`).
* Classificação manual é preservada pelas sincronizações seguintes.

## ADR-007 — Métricas como série histórica idempotente

* `app.metric_observations` guarda cada valor com fonte, conta, ativo,
  entidade, período, dimensão, coleta e atualização. Chave natural única →
  sincronizações repetidas fazem *upsert* (sem dupla contagem).
* `granularity`: `day` (anúncios e alcance diário), `lifetime` (acumulado de uma
  publicação até a data da coleta — um *snapshot* por dia, permitindo ver a
  evolução) e `snapshot` (ex.: seguidores).
* `metric_definitions` distingue métricas **fornecidas** pela fonte das
  **derivadas** pelo portal (CTR, CPC, CPM, custo por resultado, engajamento).
* Ausência de dado nunca vira zero (`src/lib/metrics.ts`): a interface
  diferencia zero real, indisponível, sem integração, processando, desatualizado
  e restrito.
* Alcance não é somado entre plataformas; somas dentro de uma fonte são
  rotuladas como "não deduplicadas". O alcance único de uma campanha da Meta
  vem da própria Meta (`lifetime`).
* Painéis pagos usam apenas o nível de campanha (evita somar campanha + anúncio).

## ADR-008 — Sincronização por fila no PostgreSQL, compatível com serverless

* `app.sync_jobs` com `FOR UPDATE SKIP LOCKED`, índice único que impede jobs
  ativos duplicados, recuperação de jobs travados (`locked_until`), novas
  tentativas com *backoff* exponencial para falhas temporárias e limite de taxa.
* Cada job respeita um prazo (`deadline`): ao atingi-lo, salva o progresso
  (`progress`) e é reenfileirado — adequado a limites de tempo de funções
  serverless.
* O agendamento é disparado por `/api/cron/sync` (Vercel Cron a cada 15 min,
  autenticado por `CRON_SECRET`) **ou** pelo processo `npm run worker` em
  hospedagem com processo contínuo. Nada depende do navegador.
* Logs por job em `app.sync_logs`, com segredos removidos (`redactSecrets`).

## ADR-009 — Credenciais cifradas em repouso

* AES-256-GCM com IV aleatório e autenticação; formato versionado `v1.`.
* `ENCRYPTION_KEY_PREVIOUS` permite rotação sem indisponibilidade
  (`npm run keys:rotate`).
* Tokens só existem em memória no servidor durante a sincronização.

## ADR-010 — PDF com @react-pdf/renderer

* Gera PDF no servidor sem navegador headless (leve, compatível com serverless).
* Relatórios publicados são **versões congeladas** (`report_versions`); a parte
  financeira fica em `report_version_financials`, protegida por RLS de
  investimento — quem não pode ver investimentos não recebe esses dados nem no
  PDF.

## ADR-011 — Modo demonstração isolado

* Dados fictícios só existem em ministérios com `is_demo = true` (e uma conta
  "[DEMO]" sem credenciais e sem sincronização). Todas as consultas filtram pelo
  modo atual; produção e demonstração nunca são agregadas juntas.

## ADR-012 — Identidade visual configurável

* Tokens de design em CSS (`src/app/globals.css`); a cor da marca é injetada em
  tempo de execução a partir de `app_settings.branding` (com fallback para
  `BRAND_*` no ambiente). Nome, organização, cor e logotipo mudam sem deploy.
* Paleta categórica dos gráficos validada (luminosidade, croma, separação para
  daltonismo) e independente da cor da marca; gráficos têm alternância para
  tabela.
