# LGPD e minimização de dados

O Atitude Insights trata **dados de comunicação e indicadores agregados**. Não
coleta dados de membros da igreja.

## Dados armazenados

| Categoria | Dados | Finalidade | Origem |
|---|---|---|---|
| Usuários do portal | nome, e-mail, perfil, vínculos, hash de senha, último acesso | autenticação e controle de acesso | convite do administrador |
| Sessões | hash do token, IP e navegador (truncados), datas | segurança e revogação | login |
| Auditoria | ator, ação, entidade, data, IP quando disponível | rastreabilidade e prestação de contas | uso do portal |
| Operação | campanhas, eventos, entregáveis, investimentos, metas | prestação de contas | cadastro no portal |
| Demandas do Asana | nome, descrição, responsável (nome), prazos, status, seção, tags, campos personalizados | histórico do trabalho executado | API do Asana |
| Meta Ads | campanhas, conjuntos, anúncios e métricas **agregadas** (investimento, impressões, alcance, cliques, resultados) | resultados de mídia paga | Marketing API |
| Meta orgânico | publicações próprias (legenda, link, data) e métricas **agregadas**; seguidores (total) | resultados orgânicos | Graph API |
| Credenciais | tokens das integrações, cifrados (AES-256-GCM) | sincronização | OAuth / token informado pelo administrador |

**Não armazenamos**: comentários de terceiros, listas de seguidores, perfis de
pessoas que interagiram, dados demográficos individuais, mensagens diretas ou
dados de inscrição/presença de pessoas. Resultados de eventos (ex.: número de
inscritos) são registrados manualmente como **totais**, sempre com a fonte.

O campo `raw` guarda o payload original das APIs para rastreabilidade; ele não
é exposto ao papel da aplicação e contém apenas dados das próprias contas.

## Controle de acesso

Cada ministério vê apenas os próprios dados (RLS). Dados de um ministério nunca
são exibidos a outro sem vínculo explícito. Detalhes em `docs/security.md`.

## Retenção

| Dado | Retenção sugerida |
|---|---|
| Métricas e relatórios publicados | enquanto houver necessidade de prestação de contas (histórico) |
| Logs de sincronização (`sync_logs`) | 180 dias |
| Sessões revogadas/expiradas | 30 dias |
| Auditoria | 2 anos |
| Convites expirados | 90 dias |

Limpeza (executar periodicamente, por exemplo via cron do banco):

```sql
delete from app.sync_logs where created_at < now() - interval '180 days';
delete from app.sessions where coalesce(revoked_at, expires_at) < now() - interval '30 days';
delete from app.invitations where accepted_at is null and expires_at < now() - interval '90 days';
delete from app.activity_logs where created_at < now() - interval '2 years';
```

## Exclusão

* **Usuário**: exclusão lógica (dados pessoais deixam de ser exibidos, sessões
  revogadas, vínculos removidos). Para exclusão definitiva, remova a linha de
  `app.users` — registros de autoria passam a "Sistema" (`on delete set null`).
* **Conta conectada**: "Desconectar" apaga as credenciais; a exclusão da conta
  remove ativos, publicações, campanhas da Meta e métricas associadas
  (`on delete cascade`).
* **Ministério**: exclusão remove em cascata os dados do ministério.
* Os tokens também devem ser revogados no provedor (Meta: Configurações →
  Integrações comerciais; Asana: Apps conectados / tokens pessoais).

## Compartilhamento com serviços externos

O portal **lê** dados do Asana e da Meta com os escopos mínimos documentados
em `docs/integrations/*.md`. Nenhum dado do portal é enviado a esses serviços
além das chamadas de leitura. Infraestrutura (hospedagem e banco) atua como
operadora; escolha regiões e contratos compatíveis com a LGPD.

## Direitos dos titulares

Usuários podem solicitar ao superadministrador acesso, correção ou exclusão de
seus dados de cadastro. O log de auditoria permite demonstrar quem acessou ou
alterou informações.
