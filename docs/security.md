# Segurança e controle de acesso

## Perfis

| Perfil | `global_role` | Escopo | Pode |
|---|---|---|---|
| Superadministrador | `superadmin` | Todos os ministérios | Tudo: usuários, convites, permissões, integrações, mapeamentos, sincronizações, logs, configurações, relatórios consolidados |
| Equipe da agência | `agency` + `agency_global_access` | `none`: só ministérios vinculados; `read`: visão global de consulta; `manage`: visão global de gestão | Conforme o papel do vínculo (`agency_manager` gerencia; `agency_viewer` consulta) |
| Liderança do ministério | `ministry` + vínculo `leader` | Somente os ministérios vinculados | Consultar dashboards, campanhas, eventos, demandas, entregáveis, resultados, relatórios publicados; investimentos apenas com `can_view_investment` |
| Responsável operacional | `ministry` + vínculo `operational` | Somente os ministérios vinculados | Igual à liderança + comentar e aprovar/solicitar ajustes em entregáveis |

Privilégio mínimo: usuários de ministério nunca recebem permissões
administrativas; um gatilho impede vínculos incompatíveis com o perfil global.

## Onde a autorização acontece

1. **Banco (RLS)** — fonte de verdade. Todas as tabelas do schema `app` têm RLS
   habilitada. Consultas de usuário rodam como `atitude_app` com
   `app.user_id` definido. Funções de autorização verificam o vínculo explícito
   e o status do usuário em cada linha.
2. **Servidor** — páginas chamam `requireActor()`/`requireSuperadmin()`;
   rotas administrativas respondem 404 (não revelam a existência). Server
   Actions e Route Handlers validam a sessão e as entradas (zod) e chamam
   serviços que usam o caminho RLS.
3. **Interface** — esconder botões é apenas conveniência, nunca proteção.

O acesso de sistema (dono das tabelas) é restrito a: autenticação (sessões,
convites, limite de tentativas), leitura/escrita de credenciais, execução da
fila de sincronização e carga de dados de demonstração — sempre após checagem
explícita de autorização no servidor.

## Proteções específicas

* **IDs na URL**: buscar um registro de outro ministério retorna "não
  encontrado" (RLS filtra a linha). Atualizações/exclusões afetam 0 linhas;
  inserções com `ministry_id` alheio violam a política.
* **Vínculos cruzados**: gatilhos impedem associar demanda/entregável/meta/
  investimento/relatório a campanha ou evento de outro ministério, e mover
  registros entre ministérios.
* **Agregações**: KPIs e gráficos são calculados no banco sob RLS; filtros
  manipulados apenas reduzem o escopo.
* **Investimentos**: tabela `investments`, métricas monetárias
  (`is_monetary`) e a seção financeira de relatórios publicados exigem
  `can_view_investment`.
* **Exportações (PDF/CSV)**: mesmas consultas RLS; CSV protegido contra
  injeção de fórmulas; respostas `Cache-Control: no-store`; exportações são
  auditadas.
* **Credenciais**: AES-256-GCM; coluna sem `GRANT` ao papel da aplicação;
  tokens nunca vão ao navegador, a logs ou a mensagens de erro (`redactSecrets`).
* **OAuth**: parâmetro `state` aleatório (hash armazenado, uso único, expira em
  10 min, vinculado ao usuário) contra CSRF; PKCE no Asana; `appsecret_proof`
  na Meta quando o segredo do app está configurado.
* **CSRF em mutações**: Server Actions do Next.js validam `Origin`/`Host`;
  cookies `SameSite=Lax`.
* **Cabeçalhos**: CSP restritiva, `X-Frame-Options: DENY`, HSTS, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` (`next.config.ts`).
* **Open redirect**: o parâmetro `next` do login aceita apenas caminhos internos.
* **Erros**: mensagens genéricas para o usuário; detalhes só em log do servidor.
* **Auditoria**: `app.activity_logs` é *append-only* para a aplicação — a
  escrita acontece apenas pela função `app.log_activity`, que registra o ator
  real (`app.user_id`), impedindo falsificação.

## Sessões e revogação

| Evento | Efeito |
|---|---|
| Logout | sessão revogada no servidor; o cookie roubado deixa de valer |
| Vínculo removido | próxima consulta já não enxerga o ministério (RLS) |
| Usuário desativado/excluído | sessões revogadas + RLS bloqueia qualquer consulta |
| Senha redefinida | sessões anteriores revogadas |
| Inatividade > `SESSION_IDLE_HOURS` | sessão expira |
| `SESSION_ABSOLUTE_DAYS` | expiração absoluta |

## Testes de aceitação de isolamento

| Critério | Onde |
|---|---|
| 1. Usuário de A não consulta B | `tests/db/rls-isolation.test.ts` (1), `tests/e2e/isolation.spec.ts` |
| 2. Alterar ID na URL | `tests/db/rls-isolation.test.ts` (2), `tests/e2e/isolation.spec.ts` |
| 3. Chamadas diretas à API | `tests/e2e/isolation.spec.ts`, `tests/e2e/auth.spec.ts` |
| 4. Exportações | `tests/db/reports-analytics.test.ts`, `tests/db/exports.test.ts`, `tests/e2e/isolation.spec.ts` |
| 5. Gráficos e KPIs | `tests/db/rls-isolation.test.ts` (5), `tests/db/reports-analytics.test.ts` |
| 6. Usuários removidos | `tests/db/rls-isolation.test.ts` (6), `tests/e2e/session-revocation.spec.ts` |
| 7. Configurações globais | `tests/db/rls-isolation.test.ts` (7), `tests/e2e/isolation.spec.ts` |
| 8. Tokens nunca no navegador | `tests/db/rls-isolation.test.ts` (8), `tests/e2e/secrets.spec.ts` |

## Recomendações de operação

* Use HTTPS (obrigatório para cookies `Secure` e callbacks OAuth).
* Guarde `ENCRYPTION_KEY`, `CRON_SECRET` e segredos dos apps em um cofre
  (Vercel/Supabase/1Password) e faça rotação periódica.
* Restrinja o acesso de rede ao banco; use usuário dono dedicado.
* Revise mensalmente a lista de usuários e convites pendentes.
