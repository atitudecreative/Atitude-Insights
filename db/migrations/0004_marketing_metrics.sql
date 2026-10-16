-- =====================================================================
-- 0004 Marketing: entidades nativas da Meta (campanhas publicitárias,
-- conjuntos, anúncios), publicações orgânicas, vínculos explícitos com
-- campanhas de comunicação e o histórico de métricas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Meta Ads (entidades NATIVAS — distintas de app.campaigns)
-- ---------------------------------------------------------------------
create table app.external_campaigns (
  id uuid primary key default gen_random_uuid(),
  external_asset_id uuid not null references app.external_assets (id) on delete cascade,
  external_id text not null,
  ministry_id uuid references app.ministries (id) on delete set null,
  name text not null,
  objective text,
  status text,
  effective_status text,
  start_time timestamptz,
  stop_time timestamptz,
  classification text not null default 'unclassified' check (classification in ('auto', 'manual', 'unclassified')),
  classification_reason text,
  removed_in_source_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (external_asset_id, external_id)
);
create index external_campaigns_ministry_idx on app.external_campaigns (ministry_id);
create trigger external_campaigns_touch before update on app.external_campaigns for each row execute function app.touch_updated_at();

create table app.external_ad_sets (
  id uuid primary key default gen_random_uuid(),
  external_campaign_id uuid not null references app.external_campaigns (id) on delete cascade,
  ministry_id uuid references app.ministries (id) on delete set null,
  external_id text not null unique,
  name text not null,
  status text,
  effective_status text,
  optimization_goal text,
  start_time timestamptz,
  end_time timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index external_ad_sets_campaign_idx on app.external_ad_sets (external_campaign_id);
create trigger external_ad_sets_touch before update on app.external_ad_sets for each row execute function app.touch_updated_at();

create table app.external_ads (
  id uuid primary key default gen_random_uuid(),
  external_ad_set_id uuid references app.external_ad_sets (id) on delete cascade,
  external_campaign_id uuid not null references app.external_campaigns (id) on delete cascade,
  ministry_id uuid references app.ministries (id) on delete set null,
  external_id text not null unique,
  name text not null,
  status text,
  effective_status text,
  creative_thumbnail_url text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index external_ads_campaign_idx on app.external_ads (external_campaign_id);
create trigger external_ads_touch before update on app.external_ads for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Publicações orgânicas (Instagram / Facebook)
-- ---------------------------------------------------------------------
create table app.social_posts (
  id uuid primary key default gen_random_uuid(),
  external_asset_id uuid not null references app.external_assets (id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook')),
  external_id text not null,
  ministry_id uuid references app.ministries (id) on delete set null,
  caption text,
  media_type text,
  media_product_type text,
  permalink text,
  thumbnail_url text,
  published_at timestamptz,
  classification text not null default 'unclassified' check (classification in ('auto', 'manual', 'unclassified')),
  classification_reason text,
  removed_in_source_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index social_posts_ministry_idx on app.social_posts (ministry_id, published_at desc);
create index social_posts_asset_idx on app.social_posts (external_asset_id, published_at desc);
create trigger social_posts_touch before update on app.social_posts for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Vínculos explícitos campanha de comunicação ⇄ itens da Meta
-- ---------------------------------------------------------------------
create table app.campaign_external_campaigns (
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  external_campaign_id uuid not null references app.external_campaigns (id) on delete cascade,
  linked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, external_campaign_id)
);
create index campaign_external_campaigns_ext_idx on app.campaign_external_campaigns (external_campaign_id);

create table app.campaign_social_posts (
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  social_post_id uuid not null references app.social_posts (id) on delete cascade,
  linked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, social_post_id)
);
create index campaign_social_posts_post_idx on app.campaign_social_posts (social_post_id);

create or replace function app.check_marketing_link() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_campaign_ministry uuid := (select ministry_id from app.campaigns where id = new.campaign_id);
  v_item_ministry uuid;
begin
  if tg_table_name = 'campaign_external_campaigns' then
    select ministry_id into v_item_ministry from app.external_campaigns where id = new.external_campaign_id;
  else
    select ministry_id into v_item_ministry from app.social_posts where id = new.social_post_id;
  end if;
  if v_item_ministry is null or v_item_ministry is distinct from v_campaign_ministry then
    raise exception 'O item precisa estar classificado no mesmo ministério da campanha' using errcode = '23514';
  end if;
  new.linked_by := coalesce(app.current_user_id(), new.linked_by);
  return new;
end;
$$;
create trigger campaign_external_campaigns_check before insert on app.campaign_external_campaigns
  for each row execute function app.check_marketing_link();
create trigger campaign_social_posts_check before insert on app.campaign_social_posts
  for each row execute function app.check_marketing_link();

-- ---------------------------------------------------------------------
-- Definições e observações de métricas (histórico)
-- ---------------------------------------------------------------------
create table app.metric_definitions (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text not null,
  unit text not null check (unit in ('count', 'currency', 'percent', 'ratio', 'seconds')),
  -- provided = fornecida diretamente pela fonte; derived = calculada pelo portal.
  origin text not null check (origin in ('provided', 'derived')),
  -- sum = aditiva no tempo/entidades; non_additive = não pode ser somada (ex.: alcance).
  aggregation text not null check (aggregation in ('sum', 'non_additive', 'latest', 'derived')),
  formula text,
  is_monetary boolean not null default false,
  sources text[] not null default '{}'
);

insert into app.metric_definitions (key, label, description, unit, origin, aggregation, formula, is_monetary, sources) values
  ('spend', 'Investimento', 'Valor investido informado pela Meta (spend).', 'currency', 'provided', 'sum', null, true, '{meta_ads}'),
  ('impressions', 'Impressões', 'Número de vezes que o anúncio foi exibido.', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('reach', 'Alcance', 'Contas únicas alcançadas no período e entidade informados pela fonte. Não é somável entre dias, entidades ou plataformas sem perder a unicidade.', 'count', 'provided', 'non_additive', null, false, '{meta_ads,instagram,facebook}'),
  ('frequency', 'Frequência', 'Média de exibições por conta alcançada (fonte).', 'ratio', 'provided', 'non_additive', null, false, '{meta_ads}'),
  ('clicks', 'Cliques', 'Cliques totais informados pela Meta.', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('link_clicks', 'Cliques no link', 'Cliques no link (inline_link_clicks).', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('ctr', 'CTR (fonte)', 'CTR informado pela Meta.', 'percent', 'provided', 'non_additive', null, false, '{meta_ads}'),
  ('cpc', 'CPC (fonte)', 'Custo por clique informado pela Meta.', 'currency', 'provided', 'non_additive', null, true, '{meta_ads}'),
  ('cpm', 'CPM (fonte)', 'Custo por mil impressões informado pela Meta.', 'currency', 'provided', 'non_additive', null, true, '{meta_ads}'),
  ('video_views', 'Visualizações de vídeo', 'Reproduções de vídeo (ação video_view).', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('results', 'Resultados', 'Resultados conforme o tipo de ação (dimensão = tipo de resultado).', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('conversions', 'Conversões', 'Ações de conversão (dimensão = action_type).', 'count', 'provided', 'sum', null, false, '{meta_ads}'),
  ('conversion_value', 'Valor de conversão', 'Valor atribuído às conversões (action_values).', 'currency', 'provided', 'sum', null, true, '{meta_ads}'),
  ('views', 'Visualizações', 'Visualizações do conteúdo (métrica "views" da Meta).', 'count', 'provided', 'sum', null, false, '{instagram,facebook}'),
  ('likes', 'Curtidas', 'Curtidas/reações.', 'count', 'provided', 'sum', null, false, '{instagram,facebook}'),
  ('comments', 'Comentários', 'Comentários.', 'count', 'provided', 'sum', null, false, '{instagram,facebook}'),
  ('shares', 'Compartilhamentos', 'Compartilhamentos.', 'count', 'provided', 'sum', null, false, '{instagram,facebook}'),
  ('saves', 'Salvamentos', 'Salvamentos (Instagram).', 'count', 'provided', 'sum', null, false, '{instagram}'),
  ('total_interactions', 'Interações', 'Total de interações informado pela fonte.', 'count', 'provided', 'sum', null, false, '{instagram,facebook}'),
  ('followers', 'Seguidores', 'Total de seguidores na data da coleta (snapshot).', 'count', 'provided', 'latest', null, false, '{instagram,facebook}'),
  ('ctr_calc', 'CTR', 'Calculado pelo portal.', 'percent', 'derived', 'derived', 'clicks / impressions × 100', false, '{meta_ads}'),
  ('cpc_calc', 'CPC', 'Calculado pelo portal.', 'currency', 'derived', 'derived', 'spend / clicks', true, '{meta_ads}'),
  ('cpm_calc', 'CPM', 'Calculado pelo portal.', 'currency', 'derived', 'derived', 'spend / impressions × 1000', true, '{meta_ads}'),
  ('cost_per_result_calc', 'Custo por resultado', 'Calculado pelo portal.', 'currency', 'derived', 'derived', 'spend / results', true, '{meta_ads}'),
  ('engagement', 'Engajamento', 'Calculado pelo portal: curtidas + comentários + compartilhamentos + salvamentos (quando disponíveis).', 'count', 'derived', 'derived', 'likes + comments + shares + saves', false, '{instagram,facebook}')
on conflict (key) do nothing;

create table app.metric_observations (
  id bigint generated always as identity primary key,
  metric_key text not null references app.metric_definitions (key),
  source text not null check (source in ('meta_ads', 'instagram', 'facebook', 'manual')),
  connected_account_id uuid references app.connected_accounts (id) on delete set null,
  external_asset_id uuid references app.external_assets (id) on delete cascade,
  ministry_id uuid references app.ministries (id) on delete set null,
  entity_type text not null check (entity_type in ('meta_campaign', 'meta_ad_set', 'meta_ad', 'social_post', 'external_asset')),
  entity_id uuid not null,
  -- day = valor do dia; lifetime = acumulado desde a publicação até period_end
  -- (um snapshot por dia de coleta); snapshot = valor pontual (ex.: seguidores).
  granularity text not null check (granularity in ('day', 'lifetime', 'snapshot')),
  period_start date not null,
  period_end date not null,
  dimension_key text not null default '',
  value numeric not null,
  currency text,
  is_monetary boolean not null default false,
  is_demo boolean not null default false,
  api_version text,
  collected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint metric_observations_period check (period_end >= period_start)
);
-- Upsert idempotente: sincronizações repetidas atualizam, nunca duplicam.
create unique index metric_observations_natural_key on app.metric_observations
  (metric_key, source, entity_type, entity_id, granularity, period_start, period_end, dimension_key);
create index metric_observations_ministry_idx on app.metric_observations (ministry_id, source, metric_key, period_start);
create index metric_observations_entity_idx on app.metric_observations (entity_type, entity_id, metric_key, period_end);

create or replace function app.fill_metric_observation() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  select d.is_monetary into new.is_monetary from app.metric_definitions d where d.key = new.metric_key;
  if new.ministry_id is not null then
    select m.is_demo into new.is_demo from app.ministries m where m.id = new.ministry_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger metric_observations_fill before insert or update on app.metric_observations
  for each row execute function app.fill_metric_observation();

-- Propaga a classificação (ministério) de uma entidade para suas métricas.
create or replace function app.propagate_entity_ministry() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_type text := case tg_table_name
    when 'external_campaigns' then 'meta_campaign'
    when 'external_ad_sets' then 'meta_ad_set'
    when 'external_ads' then 'meta_ad'
    when 'social_posts' then 'social_post' end;
begin
  if new.ministry_id is distinct from old.ministry_id then
    update app.metric_observations set ministry_id = new.ministry_id
      where entity_type = v_type and entity_id = new.id;
    if tg_table_name = 'external_campaigns' then
      update app.external_ad_sets set ministry_id = new.ministry_id where external_campaign_id = new.id;
      update app.external_ads set ministry_id = new.ministry_id where external_campaign_id = new.id;
      -- Vínculos com campanhas de outro ministério deixam de ser válidos.
      delete from app.campaign_external_campaigns l
        using app.campaigns c
        where l.external_campaign_id = new.id and c.id = l.campaign_id
          and c.ministry_id is distinct from new.ministry_id;
    elsif tg_table_name = 'social_posts' then
      delete from app.campaign_social_posts l
        using app.campaigns c
        where l.social_post_id = new.id and c.id = l.campaign_id
          and c.ministry_id is distinct from new.ministry_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger external_campaigns_propagate after update of ministry_id on app.external_campaigns
  for each row execute function app.propagate_entity_ministry();
create trigger external_ad_sets_propagate after update of ministry_id on app.external_ad_sets
  for each row execute function app.propagate_entity_ministry();
create trigger external_ads_propagate after update of ministry_id on app.external_ads
  for each row execute function app.propagate_entity_ministry();
create trigger social_posts_propagate after update of ministry_id on app.social_posts
  for each row execute function app.propagate_entity_ministry();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table app.external_campaigns enable row level security;
alter table app.external_ad_sets enable row level security;
alter table app.external_ads enable row level security;
alter table app.social_posts enable row level security;
alter table app.campaign_external_campaigns enable row level security;
alter table app.campaign_social_posts enable row level security;
alter table app.metric_definitions enable row level security;
alter table app.metric_observations enable row level security;

-- `raw` (payload original, inclui orçamentos) não é exposto ao papel da aplicação.
grant select (id, external_asset_id, external_id, ministry_id, name, objective, status, effective_status,
              start_time, stop_time, classification, classification_reason, removed_in_source_at, created_at, updated_at)
  on app.external_campaigns to atitude_app;
grant update (ministry_id, classification, classification_reason) on app.external_campaigns to atitude_app;
create policy external_campaigns_select on app.external_campaigns for select to atitude_app
  using (app.can_read_ministry(ministry_id));
create policy external_campaigns_update on app.external_campaigns for update to atitude_app
  using (app.can_manage_ministry(ministry_id) or app.has_global_manage())
  with check (app.can_manage_ministry(ministry_id));

grant select (id, external_campaign_id, ministry_id, external_id, name, status, effective_status, optimization_goal,
              start_time, end_time, created_at, updated_at)
  on app.external_ad_sets to atitude_app;
create policy external_ad_sets_select on app.external_ad_sets for select to atitude_app
  using (app.can_read_ministry(ministry_id));

grant select (id, external_ad_set_id, external_campaign_id, ministry_id, external_id, name, status, effective_status,
              creative_thumbnail_url, created_at, updated_at)
  on app.external_ads to atitude_app;
create policy external_ads_select on app.external_ads for select to atitude_app
  using (app.can_read_ministry(ministry_id));

grant select (id, external_asset_id, platform, external_id, ministry_id, caption, media_type, media_product_type,
              permalink, thumbnail_url, published_at, classification, classification_reason, removed_in_source_at,
              created_at, updated_at)
  on app.social_posts to atitude_app;
grant update (ministry_id, classification, classification_reason) on app.social_posts to atitude_app;
create policy social_posts_select on app.social_posts for select to atitude_app
  using (app.can_read_ministry(ministry_id));
create policy social_posts_update on app.social_posts for update to atitude_app
  using (app.can_manage_ministry(ministry_id) or app.has_global_manage())
  with check (app.can_manage_ministry(ministry_id));

grant select, insert, delete on app.campaign_external_campaigns, app.campaign_social_posts to atitude_app;
create policy campaign_external_campaigns_select on app.campaign_external_campaigns for select to atitude_app
  using (app.can_read_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_external_campaigns_insert on app.campaign_external_campaigns for insert to atitude_app
  with check (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_external_campaigns_delete on app.campaign_external_campaigns for delete to atitude_app
  using (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_social_posts_select on app.campaign_social_posts for select to atitude_app
  using (app.can_read_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_social_posts_insert on app.campaign_social_posts for insert to atitude_app
  with check (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_social_posts_delete on app.campaign_social_posts for delete to atitude_app
  using (app.can_manage_ministry(app.campaign_ministry(campaign_id)));

grant select on app.metric_definitions to atitude_app;
create policy metric_definitions_select on app.metric_definitions for select to atitude_app using (true);

-- Métricas monetárias (investimento, CPC, CPM...) exigem permissão de investimento.
grant select on app.metric_observations to atitude_app;
create policy metric_observations_select on app.metric_observations for select to atitude_app
  using (app.can_read_ministry(ministry_id)
         and (not is_monetary or app.can_view_investment(ministry_id)));
