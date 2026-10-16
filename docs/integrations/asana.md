# Integração com o Asana

O portal **lê** tarefas do Asana pela API oficial (`https://app.asana.com/api/1.0`)
e as transforma no histórico de demandas de cada ministério. Nada é escrito no
Asana. Código: `src/server/integrations/asana/` (`client.ts`, `oauth.ts`,
`service.ts`, `sync.ts`).

## 1. Formas de conexão

### A. Personal Access Token (mais simples)

1. No Asana: **Configurações do perfil → Apps → Console do desenvolvedor →
   Criar novo token** (use uma conta de serviço da agência com acesso apenas
   aos projetos necessários).
2. No portal: **Administração → Integrações → Asana → Conectar com token**.
3. O token é validado (`GET /users/me`) **antes** de ser salvo; em seguida é
   cifrado (AES-256-GCM) e uma descoberta de workspaces/projetos é enfileirada.

### B. OAuth (recomendado para produção)

1. Crie um app em **developers.asana.com → My apps** e cadastre a URI de
   redirecionamento: `${APP_URL}/api/integrations/asana/callback`.
2. Configure `ASANA_CLIENT_ID` e `ASANA_CLIENT_SECRET`.
3. Em **Integrações**, use **Conectar com OAuth**. O fluxo usa `state`
   aleatório (uso único, 10 minutos, vinculado ao administrador) e PKCE (S256).
4. Tokens OAuth expiram em ~1 hora; o portal usa o *refresh token* para renovar
   automaticamente e salva o novo token cifrado.

## 2. Seleção de projetos

Após a descoberta, os projetos aparecem desativados. Em
**Integrações → (conta)**, ative apenas os projetos relevantes. Projetos
removidos ou arquivados no Asana são marcados como removidos.

## 3. O que é sincronizado

Por tarefa: nome, descrição (`notes`), responsável (nome e ID), status
(`completed` e `completed_at` **somente como informado pelo Asana**), prazo
(`due_on`/`due_at`), início, criação, última modificação, seção do projeto,
tags, projetos, campos personalizados (tipo, valor exibido, opções), link
(`permalink_url`) e o ID externo (`gid`), além do payload original para
rastreabilidade (não exposto aos usuários).

O portal nunca altera o status de uma tarefa do Asana; um gatilho no banco
impede que campos sincronizados sejam editados pelo portal.

## 4. Sincronização

| Job | Quando | O que faz |
|---|---|---|
| `asana_discover` | ao conectar / manual | workspaces e projetos |
| `asana_incremental` | a cada 60 min (configurável) | `GET /tasks?project=…&modified_since=…` por projeto ativo; primeira execução = importação inicial |
| `asana_full` | a cada 24 h (configurável) | listagem completa; tarefas que não aparecem mais são marcadas como **removidas na origem** (e restauradas se voltarem) |

* Paginação por `offset` (100 itens/página) com *checkpoint* entre páginas —
  jobs longos continuam na execução seguinte.
* O cursor `modified_since` só avança quando o projeto termina, com margem de
  2 minutos (nada é perdido).
* Limites: `429` respeita `Retry-After`; `5xx` e falhas de rede têm novas
  tentativas com *backoff*; `401` marca a conta como **credencial expirada**
  (OAuth tenta renovar uma vez); `402/403` = sem permissão; `404` de projeto =
  projeto marcado como removido e job concluído como **parcial**.
* *Upsert* por `(source, external_id)`: reexecutar nunca duplica.

## 5. Mapeamento para ministérios e campanhas

Ordem de decisão (motor em `src/server/integrations/classification.ts`):

1. **Regras de mapeamento** (Administração → Integrações → conta → Regras):
   projeto, seção, tag ou campo personalizado (por opção ou valor exibido) →
   ministério, opcionalmente campanha e evento. Menor número de prioridade vence;
   regras conflitantes com a mesma prioridade **não** decidem.
2. **Vínculo do projeto**: se o projeto estiver associado a exatamente um
   ministério.
3. Caso contrário → **fila de itens não classificados** (`/classificacao`).

O nome da tarefa nunca é usado para decidir o ministério. Classificações
manuais são preservadas pelas sincronizações. A associação de uma tarefa a
campanha/evento pode ser feita no portal (Demandas → Vincular) sem alterar a
estrutura do Asana.

## 6. Limitações conhecidas

* `GET /tasks?project=` não retorna subtarefas que não estejam no projeto.
* Exclusões só são detectadas pela sincronização completa (não há "tarefas
  excluídas" no modo incremental). Usar a Events API seria uma evolução.
* Quando uma tarefa está em vários projetos ativos, a seção exibida é a do
  último projeto processado.
* Planos gratuitos do Asana não têm campos personalizados; regras desse tipo
  não se aplicam.
