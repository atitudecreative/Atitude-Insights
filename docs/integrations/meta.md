# Integração com a Meta (Facebook, Instagram e Meta Ads)

O Atitude Insights lê dados da Meta por meio da **Graph API** (orgânico do
Instagram e das Páginas do Facebook) e da **Marketing API** (campanhas,
conjuntos, anúncios e insights de anúncios). A integração é somente leitura.

Código: `src/server/integrations/meta/` (`client.ts`, `oauth.ts`, `service.ts`,
`sync.ts`, `metrics.ts`).

## 1. Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `META_APP_ID` | Para OAuth | ID do app em developers.facebook.com. |
| `META_APP_SECRET` | Para OAuth | Chave secreta do app. Também usada para calcular o `appsecret_proof` enviado em toda chamada e para validar tokens via `debug_token`. Nunca vai ao navegador. |
| `META_GRAPH_VERSION` | Não (padrão `v23.0`) | Versão da Graph API (`vNN.N`). Cada versão tem cerca de 2 anos de suporte; atualize-a de forma planejada e revise as métricas (seção 7). |
| `APP_URL` | Sim | URL pública do portal; compõe a URI de redirecionamento. |

Sem `META_APP_ID`/`META_APP_SECRET` só é possível conectar com um token de
Usuário do Sistema (seção 4), e esse token não passa pela verificação do
`debug_token`: são verificados apenas o `/me`, as permissões e a data de expiração.

## 2. Criar o app em developers.facebook.com

1. Acesse **developers.facebook.com → Meus apps → Criar app**.
2. Tipo do app: **Business (Empresa)**. Associe-o ao Business Manager da igreja/agência.
3. Adicione os produtos:
   - **Facebook Login for Business** (login OAuth);
   - **Marketing API** (leitura de anúncios e insights);
   - **Instagram Graph API** (contas profissionais do Instagram vinculadas a Páginas).
4. Em **Facebook Login for Business → Configurações**, cadastre a URI de
   redirecionamento OAuth válida:

   ```
   ${APP_URL}/api/integrations/meta/callback
   ```

   Exemplo: `https://insights.atitude.com.br/api/integrations/meta/callback`.
   Ative "Usar modo estrito para URIs de redirecionamento" e "Exigir HTTPS".
5. Em **Configurações do app → Avançado**, ative **"Exigir chave secreta do
   app" (Require App Secret)**. O portal já envia `appsecret_proof` em todas as
   chamadas; com essa opção ativada, a Meta rejeita qualquer chamada sem a
   prova, e um token vazado não pode ser usado fora do servidor.
6. Copie o **ID do app** e a **Chave secreta** para `META_APP_ID` e `META_APP_SECRET`.

## 3. Permissões solicitadas e motivo

O login pede apenas o mínimo necessário (`DEFAULT_META_SCOPES` em `oauth.ts`):

| Permissão | Para quê |
| --- | --- |
| `ads_read` | Ler contas de anúncios, campanhas, conjuntos, anúncios e insights da Marketing API. |
| `pages_show_list` | Listar as Páginas que o usuário administra (descoberta de ativos). |
| `pages_read_engagement` | Ler as publicações das Páginas e os totais de reações, comentários e compartilhamentos. Também é necessária para obter o token de Página. |
| `read_insights` | Ler os insights das Páginas e publicações (alcance, visualizações). |
| `instagram_basic` | Ler o perfil (seguidores) e a lista de mídias da conta profissional do Instagram. |
| `instagram_manage_insights` | Ler as métricas do Instagram (alcance, visualizações, salvamentos...). |
| `business_management` | Acessar ativos pertencentes a um Business Manager (contas de anúncios e Páginas da empresa). |

Nenhuma permissão de escrita (publicar, gerenciar anúncios, responder
comentários) é solicitada.

### App Review e Acesso Avançado

- No **modo de desenvolvimento**, o app só funciona para quem tem função no app
  (administradores, desenvolvedores e testadores). Isso basta para testes internos.
- Para usar o app com contas de pessoas sem função nele, é preciso:
  1. concluir a **Verificação da Empresa** (Business Verification) no Business Manager;
  2. pedir **Acesso Avançado** (Advanced Access) para cada permissão da tabela
     acima no **App Review**, com descrição de uso, screencast do fluxo de login
     e das telas onde os dados aparecem, e política de privacidade publicada;
  3. para a Marketing API, sair do nível **Development** e solicitar o nível
     **Standard** de acesso à Marketing API (Ads Management Standard Access), que
     tem limites de taxa bem maiores.
- Se a igreja usar o app apenas com os próprios ativos, a alternativa mais
  simples é o **token de Usuário do Sistema** (seção 4): ele dispensa o login
  individual e, para ativos do próprio Business, normalmente dispensa o App
  Review. Ainda assim, a Marketing API pode exigir o nível Standard para volumes maiores.

## 4. Alternativa: token de Usuário do Sistema (Business Manager)

Para uma conexão estável, que não depende da conta pessoal de alguém:

1. **Business Manager → Configurações do negócio → Usuários → Usuários do sistema → Adicionar** (função Administrador ou Funcionário).
2. **Atribuir ativos**: contas de anúncios (permissão "Ver desempenho") e Páginas
   (com o Instagram vinculado). Acesso de leitura é suficiente.
3. **Gerar novo token**: escolha o app criado acima, a validade (prefira
   "Nunca expira" se a política interna permitir) e as permissões da seção 3.
4. No portal, em **Integrações → Meta → Conectar com token**, cole o token.
   O portal chama `connectMetaWithToken`, que valida o token com `/me` e,
   quando o app está configurado, com `debug_token` (validade, app emissor,
   permissões e expiração). O token só é gravado se a validação passar, e é
   gravado cifrado com AES-256-GCM.

As Páginas aparecem na descoberta (`/me/accounts`) apenas quando foram atribuídas
ao Usuário do Sistema. Páginas do Business que não foram atribuídas não aparecem.

## 5. Expiração de tokens (importante)

A Meta **não oferece refresh token** como o Asana:

- O token obtido pelo OAuth é trocado por um **token de longa duração (~60 dias)**.
  Ele não pode ser renovado no servidor. Para estender o prazo, alguém precisa
  **reconectar** a conta (passar de novo pelo login) antes do vencimento.
- O portal grava a data em `connected_accounts.token_expires_at`.
  `testMetaConnection` informa os dias restantes (`daysRemaining`) e recomenda
  reconectar quando faltam até `META_TOKEN_RENEWAL_WARNING_DAYS` (10) dias.
  Se a data já passou, a conta é marcada como `expired` sem chamar a Meta.
- Quando a Meta responde com o código 190 ou 102 (token inválido, expirado, senha
  alterada ou permissões revogadas), o job falha sem novas tentativas e a conta
  passa para `expired`. É preciso reconectar.
- Os **tokens de Página** são obtidos a partir do token de usuário durante a
  descoberta e guardados cifrados em `credentials.pageTokens`. Derivados de um
  token de longa duração, normalmente não expiram. Ficam inválidos se o usuário
  perder a função na Página. Nesse caso a Página é ignorada com aviso (job
  `partial`) e basta rodar a descoberta novamente.
- Um token de Usuário do Sistema com "Nunca expira" tem `token_expires_at` nulo.
- `data_access_expires_at` (90 dias): a Meta também limita o acesso a dados de
  usuários que não usam o app. Para tokens de usuário, reconectar renova esse prazo.

## 6. Jobs de sincronização

| Job | O que faz |
| --- | --- |
| `meta_discover` | Lista `/me/adaccounts` → ativos `meta_ad_account` (`act_…`, com moeda, fuso e status) e `/me/accounts` → ativos `facebook_page` e `instagram_account` (o Instagram fica vinculado à Página por `parent_asset_id`). Guarda os tokens de Página. Ativos novos começam com `sync_enabled = false`: um administrador escolhe o que sincronizar. O `sync_enabled` de ativos existentes nunca é alterado. Ativos que deixam de aparecer recebem `removed_at`, que é limpo se o ativo voltar. |
| `meta_ads` | Para cada conta de anúncios habilitada: upsert de campanhas, conjuntos e anúncios, e insights diários (`time_increment=1`) nos níveis de campanha e de anúncio. Na primeira execução busca 90 dias; nas seguintes, os últimos 28 dias, porque a Meta revisa a atribuição. Também grava o alcance vitalício de cada campanha (`date_preset=maximum`). |
| `meta_organic` | Para cada conta do Instagram habilitada: seguidores (snapshot), alcance diário da conta (28 dias), mídias publicadas nos últimos 90 dias (primeira execução) ou 30 dias (seguintes) e as métricas de cada mídia. Para cada Página habilitada: seguidores, publicações, reações, comentários e compartilhamentos, e os insights de cada publicação. |

Todos os jobs:

- são **idempotentes**: as observações usam a chave natural de
  `metric_observations`, e reexecuções atualizam os valores sem duplicar linhas;
- são **retomáveis**: o progresso (ativo, etapa, intervalo e cursor de paginação)
  é salvo após cada página. Ao atingir o prazo de execução, o job devolve
  `continue` e é reenfileirado do ponto em que parou;
- tratam erros da Meta assim: 190/102 → `auth` (conta expirada, sem nova
  tentativa); 10, 3 e 200–299 → `permission`; 4, 17, 32, 613, 80000–80014,
  subcódigos de limite e HTTP 429 → `rate_limit`; 1, 2 e 5xx → `transient`;
  100 → `invalid_request`. Esperas curtas são repetidas na hora. Quando a Meta
  informa uma espera longa (`Retry-After`, ou `estimated_time_to_regain_access`
  em `X-Business-Use-Case-Usage`), o job é reagendado para depois desse prazo;
- não deixam o token aparecer em mensagens, logs ou erros. O token vai no
  cabeçalho `Authorization` e as mensagens passam por `redactSecrets`.

### Classificação por ministério

- **Campanhas**: regras `meta_campaign_name_prefix` (prefixo no nome; a regra
  pode ser restrita a uma conta de anúncios) têm precedência. Sem regra, a
  campanha vai para o ministério da conta de anúncios, desde que a conta esteja
  associada a **um único** ministério. Caso contrário, fica `unclassified` e vai
  para a fila de revisão.
- **Conjuntos e anúncios** herdam o ministério da campanha.
- **Publicações** são classificadas pela associação do ativo (conta do Instagram
  ou Página).
- Itens classificados manualmente (`classification = 'manual'`) nunca são
  reclassificados pela sincronização.

## 7. Métricas coletadas

### Meta Ads (`source = 'meta_ads'`)

Entidades `meta_campaign` e `meta_ad`. O `entity_id` é o UUID local. Granularidade `day`.

| Métrica do portal | Campo da Meta |
| --- | --- |
| `spend` | `spend` (moeda da conta) |
| `impressions` | `impressions` |
| `reach` | `reach`: alcance do dia, **não aditivo** |
| `frequency` | `frequency` |
| `clicks` | `clicks` |
| `link_clicks` | `inline_link_clicks` |
| `ctr`, `cpc`, `cpm` | valores informados pela Meta (os calculados pelo portal são `*_calc`) |
| `video_views` | `actions[action_type = video_view]` |
| `conversions` | uma linha por `action_type` da allowlist (`lead`, `complete_registration`, `purchase`, `submit_application`, `contact`, `schedule`, `subscribe`, `start_trial`, `donate`, `find_location`, `offsite_conversion.*`, `onsite_conversion.*` exceto salvamentos de post). `dimension_key = action_type` |
| `conversion_value` | `action_values`, com a mesma allowlist e a mesma dimensão |
| `results` | ação de resultado derivada do objetivo da campanha (`dimension_key`), conforme o mapa abaixo |

Alcance vitalício: na granularidade `lifetime`, `reach`, `impressions` e `spend`
por campanha, com `period_start` = início e `period_end` = último dia com dados.
Como `period_end` avança, cada dia de coleta gera um novo ponto da série.

**Mapa objetivo → resultado** (`RESULT_ACTION_BY_OBJECTIVE` em `metrics.ts`):

| Objetivo | Ação de resultado |
| --- | --- |
| `OUTCOME_TRAFFIC`, `LINK_CLICKS` | `link_click` |
| `OUTCOME_ENGAGEMENT`, `POST_ENGAGEMENT` | `post_engagement` |
| `PAGE_LIKES` | `like` |
| `OUTCOME_LEADS`, `LEAD_GENERATION` | `lead` |
| `OUTCOME_SALES` | `offsite_conversion.fb_pixel_purchase` |
| `OUTCOME_APP_PROMOTION`, `APP_INSTALLS` | `mobile_app_install` |
| `VIDEO_VIEWS` | `video_view` |
| `MESSAGES` | `onsite_conversion.messaging_conversation_started_7d` |
| `OUTCOME_AWARENESS`, `BRAND_AWARENESS`, `REACH` | nenhuma: o resultado é o próprio alcance, e `results` não é gravado |
| outros (ex.: `CONVERSIONS` legado) | não mapeado: `results` não é gravado |

No Gerenciador de Anúncios, o "resultado" depende da **meta de otimização do
conjunto** (`optimization_goal`), não só do objetivo. O mapa acima é uma
aproximação explícita e conservadora. Por isso os resultados ficam por tipo de
ação (`dimension_key`), e o custo por resultado é calculado pelo portal.

### Instagram (`source = 'instagram'`)

- Conta (`entity_type = 'external_asset'`): `followers`, um snapshot por dia de
  coleta, e `reach` diário da conta (`/insights?metric=reach&period=day`).
- Mídias (`social_posts`, `platform = 'instagram'`): `reach`, `views`, `likes`,
  `comments`, `shares`, `saves` (vem de `saved` na API) e `total_interactions`. Granularidade
  `lifetime`: `period_start` é a data de publicação (UTC) e `period_end` a data
  da coleta. Cada dia gera um snapshot do acumulado, o que forma o histórico de evolução.
  `like_count` e `comments_count` da lista de mídias também são gravados.

### Facebook (`source = 'facebook'`)

- Página: `followers` (`followers_count`, ou `fan_count` quando aquele não vem).
- Publicações (`platform = 'facebook'`): `likes` (total de reações), `comments`
  e `shares` (dos resumos da própria publicação), mais os insights opcionais
  `post_impressions_unique` → `reach` e `post_media_view` → `views`.

## 8. Limitações conhecidas

- **A disponibilidade de métricas varia** com o tipo de conta (criador ou
  empresa), o tipo de mídia (FEED, REELS, STORY, CAROUSEL), a versão da API e a
  idade da mídia. O portal trata **toda métrica de insights como opcional**.
  Quando o lote falha com o código 100, as métricas são repetidas uma a uma e o
  resultado vai para `app.metric_availability` (ativo, métrica, escopo =
  `media_product_type`/`media_type`, `account` ou `facebook_post`, motivo). O job
  termina como `partial`, com mensagem clara, mas não falha. Mídias publicadas
  antes da conversão para conta profissional (subcódigo 2108006) ficam sem insights.
- **Métrica ausente ≠ zero.** Se a Meta não informa uma métrica, nada é gravado.
  Um `"0"` explícito é gravado como 0. Por isso, publicações do Facebook sem
  compartilhamentos (a Meta omite `shares`) ficam sem a métrica `shares`.
- **Alcance não é aditivo.** Não some `reach` entre dias, campanhas, anúncios ou
  plataformas. Para períodos longos use o alcance vitalício da campanha
  (`granularity = 'lifetime'`). Alcance do Instagram e do Facebook **nunca** é somado.
- **Revisões de atribuição.** A Meta revisa conversões por até ~28 dias (janelas
  de atribuição de 7 dias após o clique e 1 dia após a visualização, entre
  outras). Por isso a janela de 28 dias é sempre reprocessada. Quando um tipo
  de ação some de um dia reprocessado, a observação derivada (`conversions`,
  `conversion_value`, `results`, `video_views`) é removida. A consulta usa
  `use_unified_attribution_setting=true`, para respeitar a configuração de
  atribuição de cada conjunto, como no Gerenciador de Anúncios.
- Os dados de anúncios anteriores à janela de backfill (90 dias) não são
  importados, com exceção do alcance vitalício.
- **Descontinuações.** As métricas de Página e de publicação do Facebook foram
  renomeadas ou descontinuadas várias vezes (ex.: `post_impressions` →
  `post_media_view`). No Instagram, `impressions` e `plays` foram substituídas
  por `views`. Ao subir `META_GRAPH_VERSION`, confira o changelog da Graph API e
  a tabela `metric_availability`.
- Os insights são consultados de forma **síncrona**, em intervalos de até 31
  dias. Contas com muitos anúncios podem atingir limites de taxa: o job é
  reagendado automaticamente. Contas muito grandes podem exigir relatórios
  assíncronos (`POST /act_x/insights`), que ainda não foram implementados.
- Anúncios excluídos que não aparecem em `/act_x/ads` não têm métricas no nível
  de anúncio (ficam contabilizados em `insightsSkipped`). As métricas no nível
  de campanha não são afetadas.
- `cost_per_action_type` é solicitado, mas não é gravado: o custo por resultado é
  calculado pelo portal (`cost_per_result_calc`).
- Orçamentos (`daily_budget`, `lifetime_budget`) ficam apenas em
  `external_campaigns.raw`, que não é exposto ao papel da aplicação.
- Campanhas, publicações e anúncios removidos na origem ainda não são marcados
  com `removed_in_source_at` (somente ativos recebem `removed_at` na descoberta).
- Ativos do Business que não foram atribuídos ao usuário ou ao Usuário do
  Sistema (ex.: `owned_pages` não atribuídas) não são descobertos.
