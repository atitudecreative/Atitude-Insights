# Atitude Insights

Portal de inteligência, campanhas e prestação de contas da agência de
comunicação para os ministérios, departamentos e áreas internas da igreja.

Conecta três dimensões:

1. **Operação** — demandas, entregáveis, responsáveis e prazos (Asana + cadastro no portal).
2. **Comunicação** — campanhas de comunicação, eventos, publicações e materiais.
3. **Resultados** — alcance, engajamento, anúncios pagos, investimento e conversões (Meta).

Cada ministério vê apenas o que lhe pertence; a agência tem a visão operacional
global; relatórios em PDF respeitam as mesmas permissões.

> O nome, a marca, as cores e o logotipo são configuráveis
> (Administração → Configurações, ou variáveis `BRAND_*`).

## Stack

| Camada | Tecnologia |
|---|---|
| Aplicação | Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript estrito |
| UI | Tailwind CSS 4, primitivas acessíveis Radix (`radix-ui`), ícones Lucide, Recharts, fonte Geist |
| Banco | PostgreSQL 14+ (Supabase, Neon, RDS ou local) com **Row Level Security**; Kysely + tipos gerados |
| Autenticação | sessões próprias no banco (scrypt, cookies httpOnly), convites de uso único |
| Integrações | Asana API, Meta Graph API e Marketing API — fila de sincronização no PostgreSQL |
| PDF | @react-pdf/renderer (sem navegador headless) |
| Testes | Vitest (unitário + banco real) e Playwright (E2E, acessibilidade com axe) |

Decisões e justificativas: [`docs/architecture.md`](docs/architecture.md).

## Funcionalidades

* **Painel da agência** (`/painel`): KPIs operacionais e de comunicação clicáveis,
  evolução, demandas por período e status, desempenho por ministério,
  investimento por campanha, canais, próximos eventos e entregas, atividades
  recentes e alertas de sincronização. Filtros por período, ministério,
  campanha, evento e canal (gaveta no mobile).
* **Painel do ministério** (`/ministerios/[slug]`): saudação, período, campanhas
  ativas, próximos eventos, demandas, entregáveis, alcance orgânico, anúncios,
  investimento (se autorizado), melhores publicações, evolução e relatórios.
  Estados vazios orientam o que conectar/cadastrar.
* Diferenciação visual de **zero real**, **indisponível**, **sem integração**,
  **processando**, **desatualizado** e **restrito**.
* **Campanhas** (planejamento → arquivada) com visão geral, metas, linha do
  tempo, demandas, entregáveis, desempenho orgânico e pago, investimento,
  comparativos, histórico e relatório final; vínculo explícito com campanhas
  publicitárias e publicações da Meta.
* **Eventos** com etapas de comunicação (planejamento, produção, divulgação,
  evento, pós-evento, consolidação), campanhas relacionadas, links e resultados
  pós-evento sempre com fonte declarada.
* **Demandas** (Asana ou manuais), **entregáveis** com aprovação e comentários,
  **investimentos** planejados/realizados.
* **Classificação** de itens externos: regras explícitas, vínculo ativo ⇄
  ministério e fila de revisão manual.
* **Resultados**: orgânico × pago separados, métricas fornecidas × calculadas,
  disponibilidade real por conta.
* **Relatórios** por ministério, campanha, evento, período e canal: prévia no
  portal, revisão, texto editorial separado dos fatos observados, publicação
  em versões congeladas e PDF.
* **Administração**: ministérios, usuários, convites, permissões, contas
  conectadas, ativos e mapeamentos, regras, status das integrações (testar
  conexão / sincronizar agora), histórico e logs de sincronização, auditoria,
  identidade visual e dados de demonstração.
* **Exportações** CSV (demandas, métricas) com o mesmo controle de acesso.

## Executar localmente

Pré-requisitos: Node.js 20.9+ (recomendado 22) e PostgreSQL 14+.

```bash
npm install
cp .env.example .env.local          # preencha DATABASE_URL, ENCRYPTION_KEY, CRON_SECRET
# gere a chave: openssl rand -base64 32

# banco
createdb atitude_insights            # ou use um projeto Supabase/Neon
set -a; source .env.local; set +a
npm run db:migrate
npm run db:seed-admin -- voce@igreja.org "Seu Nome"   # pede a senha

npm run dev                          # http://localhost:3000
npm run worker                       # (opcional) sincronização contínua local
```

Alternativa com Docker (PostgreSQL + app + worker):

```bash
cp .env.example .env   # ajuste ENCRYPTION_KEY e CRON_SECRET
docker compose up --build
docker compose run --rm web npm run db:seed-admin -- voce@igreja.org "Seu Nome"
```

Dados fictícios para conhecer o sistema: **Administração → Configurações →
Dados de demonstração** e alterne para "Modo demonstração" no menu. Eles ficam
isolados em ministérios `[DEMO]` e nunca são somados aos dados reais.

## Comandos

| Comando | Descrição |
|---|---|
| `npm run dev` / `build` / `start` | desenvolvimento, build e produção |
| `npm run db:migrate` | aplica migrações pendentes (idempotente, com checksum) |
| `npm run db:types` | regenera os tipos a partir do banco |
| `npm run db:seed-admin -- email "Nome"` | cria/promove o superadministrador |
| `npm run worker` | agendador contínuo de sincronizações |
| `npm run keys:rotate` | recifra credenciais após trocar `ENCRYPTION_KEY` |
| `npm run typecheck` / `lint` | TypeScript e ESLint |
| `npm test` | testes unitários e de banco (requer PostgreSQL) |
| `npm run test:e2e` | E2E (requer `npm run build` e PostgreSQL) |

Os testes de banco recriam o banco `atitude_test` usando
`TEST_DATABASE_ADMIN_URL` (padrão `postgresql://atitude:atitude@localhost:5432/postgres`);
o E2E usa `atitude_e2e`.

## Implantação em produção

### Opção recomendada: Vercel + Supabase (Postgres)

1. **Banco**: crie um projeto no Supabase (região São Paulo). Use a *connection
   string* do pooler em modo transação (porta 6543) como `DATABASE_URL` da
   aplicação. Rode as migrações com a conexão direta (porta 5432):
   `DATABASE_URL=... npm run db:migrate`. As tabelas ficam no schema `app`, que
   não é exposto pela API REST do Supabase.
2. **Aplicação**: importe o repositório na Vercel e configure as variáveis do
   `.env.example` (`APP_URL` com o domínio HTTPS final).
3. **Agendamento**: `vercel.json` já agenda `/api/cron/sync` a cada 15 minutos.
   A Vercel envia `Authorization: Bearer $CRON_SECRET`. No plano Hobby o cron é
   diário — use um agendador externo (ex.: GitHub Actions, cron-job.org) com o
   mesmo cabeçalho, ou a opção abaixo. Cada execução respeita ~50 s e jobs longos
   continuam na seguinte.
4. Crie o superadministrador (`npm run db:seed-admin`) apontando para o banco de produção.
5. Configure as integrações (`docs/integrations/asana.md`, `docs/integrations/meta.md`).

### Opção com processo contínuo (Docker/VPS/Railway/Fly/Render)

Rode duas instâncias da mesma imagem: `web` (`next start`) e `worker`
(`npm run worker`). Ver `Dockerfile` e `docker-compose.yml`.

### Checklist de produção

* HTTPS obrigatório; `APP_URL` correto (callbacks OAuth e links de convite).
* `ENCRYPTION_KEY` e `CRON_SECRET` fortes, guardados em cofre de segredos.
* Backups do PostgreSQL ativos (Supabase faz diariamente; ative PITR se possível).
* Revise `docs/security.md` e `docs/lgpd.md`.

## Variáveis de ambiente

Veja [`.env.example`](.env.example). Obrigatórias: `DATABASE_URL`,
`ENCRYPTION_KEY`, `APP_URL`; `CRON_SECRET` para o agendador HTTP. Integrações:
`ASANA_CLIENT_ID/SECRET` (OAuth opcional), `META_APP_ID/SECRET`,
`META_GRAPH_VERSION`.

## Documentação

* [Arquitetura e decisões](docs/architecture.md)
* [Segurança e controle de acesso](docs/security.md)
* [Banco de dados](docs/database.md)
* [LGPD e minimização de dados](docs/lgpd.md)
* [Integração Asana](docs/integrations/asana.md)
* [Integração Meta](docs/integrations/meta.md)
* [Estado do projeto e pendências](docs/status.md)
