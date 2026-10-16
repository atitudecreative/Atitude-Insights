# Estado do projeto e pendências

Atualizado ao final de cada etapa de desenvolvimento.

## Fases

| Fase | Situação |
|---|---|
| 1 — Fundação (stack, banco, migrações, autenticação, papéis, RLS, design system, navegação) | concluída; isolamento validado por testes |
| 2 — Núcleo operacional (ministérios, usuários, campanhas, eventos, demandas, entregáveis, relacionamentos, histórico) | concluída |
| 3 — Asana (credenciais, OAuth/PAT, importação inicial, incremental, reconciliação, mapeamento, logs) | concluída com testes usando API simulada; **validação real pendente de credenciais** |
| 4 — Meta (OAuth/token de sistema, ativos, Ads, orgânico, histórico, disponibilidade de métricas) | concluída com testes usando API simulada; **validação real pendente de app aprovado e credenciais** |
| 5 — Dashboards e analytics | concluída |
| 6 — Relatórios (portal, revisão, versões, PDF, controle de acesso) | concluída |
| 7 — Refinamento (responsividade, acessibilidade, E2E, segurança, documentação) | concluída; ver testes executados |

## O que depende de configuração externa

1. **Asana**: Personal Access Token de uma conta de serviço *ou* app OAuth
   (`ASANA_CLIENT_ID/SECRET`) com a URI `${APP_URL}/api/integrations/asana/callback`.
2. **Meta**: app do tipo Business com Facebook Login for Business, Marketing API
   e Instagram Graph API; permissões `ads_read`, `pages_show_list`,
   `pages_read_engagement`, `read_insights`, `instagram_basic`,
   `instagram_manage_insights`, `business_management` — com **Acesso Avançado /
   App Review** para uso fora dos administradores do app. Alternativa: token de
   Usuário do Sistema do Business Manager.
3. **Produção**: domínio HTTPS, banco gerenciado, `ENCRYPTION_KEY`,
   `CRON_SECRET` e agendador (Vercel Cron ou worker).

Nenhuma credencial real foi utilizada no desenvolvimento; as integrações foram
validadas com simulações fiéis aos formatos das APIs (paginação, limites,
erros de autenticação, métricas indisponíveis). A primeira sincronização real
deve ser acompanhada em **Administração → Sincronizações**.

## Limitações conhecidas

* Envio de e-mail não está integrado: convites e redefinições geram um link de
  uso único que o administrador envia ao usuário.
* Entregáveis armazenam **links** (Drive, Canva, Frame.io...), não arquivos —
  não há armazenamento de arquivos privados no portal.
* Asana: exclusões só são detectadas na sincronização completa (diária);
  subtarefas fora do projeto não são importadas.
* Meta: métricas variam por tipo de conta, mídia e versão da API — o portal
  registra a disponibilidade por conta e não preenche lacunas. "Resultados" é
  derivado do objetivo da campanha (mapa documentado) e pode diferir do
  Gerenciador de Anúncios. Tokens de usuário duram ~60 dias e precisam ser
  renovados (alerta 10 dias antes); prefira token de Usuário do Sistema.
* Insights da Meta são consultados de forma síncrona em blocos de 31 dias;
  contas muito grandes podem exigir relatórios assíncronos.
* Alcance somado entre dias/campanhas é rotulado como não deduplicado; o alcance
  único por campanha vem do valor "vida útil" informado pela Meta.
* Métricas digitais não comprovam presença física ou inscrições: resultados de
  eventos devem ser registrados manualmente com a fonte.
