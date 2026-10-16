-- =====================================================================
-- 0003 Núcleo operacional: canais, campanhas de comunicação, eventos,
-- demandas (tarefas), entregáveis, investimentos, metas e regras de
-- classificação de itens externos.
-- =====================================================================

-- Helper de migração: aplica as políticas padrão "ler se pode ler o
-- ministério, escrever se pode gerenciar o ministério".
create or replace function app._apply_ministry_policies(
  p_table text,
  p_read text default 'app.can_read_ministry(ministry_id)',
  p_write text default 'app.can_manage_ministry(ministry_id)'
) returns void language plpgsql as $$
begin
  execute format('alter table app.%I enable row level security', p_table);
  execute format('create policy %I on app.%I for select to atitude_app using (%s)', p_table || '_select', p_table, p_read);
  execute format('create policy %I on app.%I for insert to atitude_app with check (%s)', p_table || '_insert', p_table, p_write);
  execute format('create policy %I on app.%I for update to atitude_app using (%s) with check (%s)', p_table || '_update', p_table, p_write, p_write);
  execute format('create policy %I on app.%I for delete to atitude_app using (%s)', p_table || '_delete', p_table, p_write);
end;
$$;
revoke all on function app._apply_ministry_policies(text, text, text) from public;

-- Garante que vínculos (campanha, evento, demanda, entregável) pertençam ao
-- mesmo ministério do registro. Impede associação cruzada entre ministérios.
create or replace function app.enforce_ministry_scope() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  j jsonb := to_jsonb(new);
  m uuid := nullif(j->>'ministry_id', '')::uuid;
  v uuid;
begin
  if j ? 'campaign_id' and j->>'campaign_id' is not null then
    select ministry_id into v from app.campaigns where id = (j->>'campaign_id')::uuid;
    if m is null or v is distinct from m then
      raise exception 'A campanha informada pertence a outro ministério' using errcode = '23514';
    end if;
  end if;
  if j ? 'event_id' and j->>'event_id' is not null then
    select ministry_id into v from app.events where id = (j->>'event_id')::uuid;
    if m is null or v is distinct from m then
      raise exception 'O evento informado pertence a outro ministério' using errcode = '23514';
    end if;
  end if;
  if j ? 'task_id' and j->>'task_id' is not null then
    select ministry_id into v from app.tasks where id = (j->>'task_id')::uuid;
    if m is null or v is distinct from m then
      raise exception 'A demanda informada pertence a outro ministério' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.prevent_ministry_change() returns trigger
language plpgsql as $$
begin
  if new.ministry_id is distinct from old.ministry_id then
    raise exception 'Não é permitido mover este registro para outro ministério' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Canais
-- ---------------------------------------------------------------------
create table app.channels (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]+$'),
  name text not null,
  kind text not null check (kind in ('organic', 'paid', 'owned', 'offline', 'other')),
  sort_order integer not null default 100,
  active boolean not null default true
);
alter table app.channels enable row level security;
grant select, insert, update on app.channels to atitude_app;
create policy channels_select on app.channels for select to atitude_app using (app.current_user_id() is not null);
create policy channels_insert on app.channels for insert to atitude_app with check (app.is_superadmin());
create policy channels_update on app.channels for update to atitude_app using (app.is_superadmin()) with check (app.is_superadmin());

insert into app.channels (key, name, kind, sort_order) values
  ('instagram', 'Instagram (orgânico)', 'organic', 10),
  ('facebook', 'Facebook (orgânico)', 'organic', 20),
  ('meta_ads', 'Meta Ads (pago)', 'paid', 30),
  ('youtube', 'YouTube', 'organic', 40),
  ('whatsapp', 'WhatsApp', 'owned', 50),
  ('email', 'E-mail', 'owned', 60),
  ('landing_page', 'Landing page / site', 'owned', 70),
  ('telao', 'Telão / culto', 'offline', 80),
  ('impresso', 'Material impresso', 'offline', 90)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Campanhas de comunicação (entidade interna — NÃO é a campanha da Meta)
-- ---------------------------------------------------------------------
create table app.campaigns (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  name text not null check (length(name) between 2 and 200),
  description text,
  objective text,
  target_audience text,
  start_date date,
  end_date date,
  status text not null default 'planning' check (status in (
    'planning', 'production', 'awaiting_approval', 'scheduled', 'active', 'completed', 'archived')),
  final_summary text,
  learnings text,
  observations text,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint campaigns_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index campaigns_ministry_idx on app.campaigns (ministry_id, status);
create index campaigns_dates_idx on app.campaigns (start_date, end_date);
create trigger campaigns_touch before update on app.campaigns for each row execute function app.touch_updated_at();
create trigger campaigns_lock_ministry before update on app.campaigns for each row execute function app.prevent_ministry_change();
grant select, insert, update, delete on app.campaigns to atitude_app;
select app._apply_ministry_policies('campaigns');

create table app.campaign_responsibles (
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  primary key (campaign_id, user_id)
);
create table app.campaign_channels (
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  channel_id uuid not null references app.channels (id) on delete restrict,
  primary key (campaign_id, channel_id)
);

-- ---------------------------------------------------------------------
-- Eventos
-- ---------------------------------------------------------------------
create table app.events (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  name text not null check (length(name) between 2 and 200),
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  communication_objective text,
  promotion_start date,
  promotion_end date,
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  status text not null default 'planned' check (status in ('planned', 'confirmed', 'finished', 'cancelled')),
  results_summary text,
  observations text,
  results_consolidated_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint events_dates check (ends_at is null or ends_at >= starts_at),
  constraint events_promotion_dates check (promotion_end is null or promotion_start is null or promotion_end >= promotion_start)
);
create index events_ministry_idx on app.events (ministry_id, starts_at);
create trigger events_touch before update on app.events for each row execute function app.touch_updated_at();
create trigger events_lock_ministry before update on app.events for each row execute function app.prevent_ministry_change();
grant select, insert, update, delete on app.events to atitude_app;
select app._apply_ministry_policies('events');

create table app.event_responsibles (
  event_id uuid not null references app.events (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  primary key (event_id, user_id)
);

create table app.campaign_events (
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  event_id uuid not null references app.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, event_id)
);
create index campaign_events_event_idx on app.campaign_events (event_id);
create or replace function app.check_campaign_event() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if (select ministry_id from app.campaigns where id = new.campaign_id)
     is distinct from (select ministry_id from app.events where id = new.event_id) then
    raise exception 'Campanha e evento precisam pertencer ao mesmo ministério' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger campaign_events_check before insert or update on app.campaign_events
  for each row execute function app.check_campaign_event();

-- Políticas de tabelas de associação: herdam a visibilidade do registro pai.
alter table app.campaign_responsibles enable row level security;
alter table app.campaign_channels enable row level security;
alter table app.event_responsibles enable row level security;
alter table app.campaign_events enable row level security;
grant select, insert, delete on app.campaign_responsibles, app.campaign_channels,
  app.event_responsibles, app.campaign_events to atitude_app;

create or replace function app.campaign_ministry(p_campaign uuid) returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select ministry_id from app.campaigns where id = p_campaign
$$;
create or replace function app.event_ministry(p_event uuid) returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select ministry_id from app.events where id = p_event
$$;
revoke all on function app.campaign_ministry(uuid), app.event_ministry(uuid) from public;
grant execute on function app.campaign_ministry(uuid), app.event_ministry(uuid) to atitude_app;

create policy campaign_responsibles_select on app.campaign_responsibles for select to atitude_app
  using (app.can_read_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_responsibles_insert on app.campaign_responsibles for insert to atitude_app
  with check (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_responsibles_delete on app.campaign_responsibles for delete to atitude_app
  using (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_channels_select on app.campaign_channels for select to atitude_app
  using (app.can_read_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_channels_insert on app.campaign_channels for insert to atitude_app
  with check (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_channels_delete on app.campaign_channels for delete to atitude_app
  using (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy event_responsibles_select on app.event_responsibles for select to atitude_app
  using (app.can_read_ministry(app.event_ministry(event_id)));
create policy event_responsibles_insert on app.event_responsibles for insert to atitude_app
  with check (app.can_manage_ministry(app.event_ministry(event_id)));
create policy event_responsibles_delete on app.event_responsibles for delete to atitude_app
  using (app.can_manage_ministry(app.event_ministry(event_id)));
create policy campaign_events_select on app.campaign_events for select to atitude_app
  using (app.can_read_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_events_insert on app.campaign_events for insert to atitude_app
  with check (app.can_manage_ministry(app.campaign_ministry(campaign_id)));
create policy campaign_events_delete on app.campaign_events for delete to atitude_app
  using (app.can_manage_ministry(app.campaign_ministry(campaign_id)));

-- Resultados de eventos registrados manualmente, sempre com fonte.
create table app.event_results (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  event_id uuid not null references app.events (id) on delete cascade,
  label text not null,
  value numeric,
  unit text not null default 'count',
  source text not null check (length(source) >= 2),
  notes text,
  recorded_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index event_results_event_idx on app.event_results (event_id);
create trigger event_results_scope before insert or update on app.event_results
  for each row execute function app.enforce_ministry_scope();
grant select, insert, update, delete on app.event_results to atitude_app;
select app._apply_ministry_policies('event_results');

-- ---------------------------------------------------------------------
-- Demandas (Asana ou manuais)
-- ---------------------------------------------------------------------
create table app.tasks (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid references app.ministries (id) on delete set null,
  campaign_id uuid references app.campaigns (id) on delete set null,
  event_id uuid references app.events (id) on delete set null,
  source text not null check (source in ('asana', 'manual')),
  external_id text,
  connected_account_id uuid references app.connected_accounts (id) on delete set null,
  name text not null,
  notes text,
  assignee_name text,
  assignee_external_id text,
  -- Status de origem. 'completed' só com evidência na origem (Asana `completed`).
  completed boolean not null default false,
  completed_at timestamptz,
  due_on date,
  due_at timestamptz,
  start_on date,
  created_at_source timestamptz,
  modified_at_source timestamptz,
  section_name text,
  section_external_id text,
  tags text[] not null default '{}',
  projects jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  permalink_url text,
  -- auto (regra/ativo), manual (revisão humana), unclassified (fila de revisão).
  classification text not null default 'unclassified'
    check (classification in ('auto', 'manual', 'unclassified')),
  classification_reason text,
  removed_in_source_at timestamptz,
  raw jsonb,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_external_id_required check (source = 'manual' or external_id is not null),
  constraint tasks_campaign_needs_ministry check (ministry_id is not null or (campaign_id is null and event_id is null))
);
create unique index tasks_source_external_key on app.tasks (source, external_id) where external_id is not null;
create index tasks_ministry_idx on app.tasks (ministry_id, completed, due_on);
create index tasks_campaign_idx on app.tasks (campaign_id);
create index tasks_event_idx on app.tasks (event_id);
create index tasks_unclassified_idx on app.tasks (classification) where ministry_id is null;
create index tasks_completed_at_idx on app.tasks (completed_at);
create trigger tasks_touch before update on app.tasks for each row execute function app.touch_updated_at();
create trigger tasks_scope before insert or update on app.tasks for each row execute function app.enforce_ministry_scope();

-- Dados vindos do Asana são somente leitura para usuários: só a
-- classificação (ministério/campanha/evento) pode ser alterada no portal.
create or replace function app.protect_external_task_fields() returns trigger
language plpgsql as $$
begin
  if current_user = 'atitude_app' and old.source <> 'manual' then
    if (new.name, new.notes, new.completed, new.completed_at, new.due_on, new.due_at, new.assignee_name,
        new.section_name, new.tags, new.external_id, new.source, new.permalink_url, new.removed_in_source_at)
       is distinct from
       (old.name, old.notes, old.completed, old.completed_at, old.due_on, old.due_at, old.assignee_name,
        old.section_name, old.tags, old.external_id, old.source, old.permalink_url, old.removed_in_source_at) then
      raise exception 'Campos sincronizados do Asana não podem ser alterados no portal' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger tasks_protect_external before update on app.tasks
  for each row execute function app.protect_external_task_fields();

grant select (id, ministry_id, campaign_id, event_id, source, external_id, connected_account_id, name, notes,
              assignee_name, assignee_external_id, completed, completed_at, due_on, due_at, start_on,
              created_at_source, modified_at_source, section_name, section_external_id, tags, projects,
              custom_fields, permalink_url, classification, classification_reason, removed_in_source_at,
              created_by, created_at, updated_at)
  on app.tasks to atitude_app;
grant insert (ministry_id, campaign_id, event_id, source, name, notes, assignee_name, completed, completed_at,
              due_on, start_on, classification, classification_reason, created_by)
  on app.tasks to atitude_app;
grant update (ministry_id, campaign_id, event_id, name, notes, assignee_name, completed, completed_at, due_on,
              start_on, classification, classification_reason)
  on app.tasks to atitude_app;
grant delete on app.tasks to atitude_app;
alter table app.tasks enable row level security;
create policy tasks_select on app.tasks for select to atitude_app using (app.can_read_ministry(ministry_id));
create policy tasks_insert on app.tasks for insert to atitude_app
  with check (source = 'manual' and app.can_manage_ministry(ministry_id));
create policy tasks_update on app.tasks for update to atitude_app
  using (app.can_manage_ministry(ministry_id)) with check (app.can_manage_ministry(ministry_id));
create policy tasks_delete on app.tasks for delete to atitude_app
  using (source = 'manual' and app.can_manage_ministry(ministry_id));

-- ---------------------------------------------------------------------
-- Entregáveis
-- ---------------------------------------------------------------------
create table app.deliverables (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  campaign_id uuid references app.campaigns (id) on delete set null,
  event_id uuid references app.events (id) on delete set null,
  task_id uuid references app.tasks (id) on delete set null,
  title text not null check (length(title) between 2 and 200),
  description text,
  type text not null check (type in (
    'arte', 'video', 'reels', 'story', 'carrossel', 'landing_page', 'email', 'impresso',
    'identidade_visual', 'fotografia', 'texto', 'anuncio', 'outro')),
  status text not null default 'in_production' check (status in (
    'in_production', 'in_review', 'changes_requested', 'approved', 'delivered', 'cancelled')),
  url text check (url is null or url ~* '^https?://'),
  due_date date,
  delivered_at timestamptz,
  approved_by uuid references app.users (id) on delete set null,
  approved_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deliverables_ministry_idx on app.deliverables (ministry_id, status);
create index deliverables_campaign_idx on app.deliverables (campaign_id);
create index deliverables_event_idx on app.deliverables (event_id);
create trigger deliverables_touch before update on app.deliverables for each row execute function app.touch_updated_at();
create trigger deliverables_scope before insert or update on app.deliverables for each row execute function app.enforce_ministry_scope();
create trigger deliverables_lock_ministry before update on app.deliverables for each row execute function app.prevent_ministry_change();
grant select, insert, update, delete on app.deliverables to atitude_app;
alter table app.deliverables enable row level security;
create policy deliverables_select on app.deliverables for select to atitude_app using (app.can_read_ministry(ministry_id));
create policy deliverables_insert on app.deliverables for insert to atitude_app with check (app.can_manage_ministry(ministry_id));
-- Responsáveis operacionais podem atualizar (aprovar / pedir ajustes); o
-- serviço limita quais campos cada papel altera.
create policy deliverables_update on app.deliverables for update to atitude_app
  using (app.can_collaborate(ministry_id)) with check (app.can_collaborate(ministry_id));
create policy deliverables_delete on app.deliverables for delete to atitude_app using (app.can_manage_ministry(ministry_id));

-- Responsáveis operacionais só podem alterar status/aprovação.
create or replace function app.protect_deliverable_fields() returns trigger
language plpgsql as $$
begin
  if current_user = 'atitude_app' and not app.can_manage_ministry(old.ministry_id) then
    if (new.title, new.description, new.type, new.url, new.due_date, new.campaign_id, new.event_id, new.task_id)
       is distinct from
       (old.title, old.description, old.type, old.url, old.due_date, old.campaign_id, old.event_id, old.task_id) then
      raise exception 'Sem permissão para editar este entregável' using errcode = '42501';
    end if;
    if new.status not in ('approved', 'changes_requested') then
      raise exception 'Sem permissão para este status' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger deliverables_protect before update on app.deliverables
  for each row execute function app.protect_deliverable_fields();

create table app.deliverable_comments (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  deliverable_id uuid not null references app.deliverables (id) on delete cascade,
  user_id uuid references app.users (id) on delete set null,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index deliverable_comments_idx on app.deliverable_comments (deliverable_id, created_at);
create or replace function app.check_comment_scope() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if (select ministry_id from app.deliverables where id = new.deliverable_id) is distinct from new.ministry_id then
    raise exception 'Comentário fora do escopo do entregável' using errcode = '23514';
  end if;
  new.user_id := coalesce(app.current_user_id(), new.user_id);
  return new;
end;
$$;
create trigger deliverable_comments_scope before insert on app.deliverable_comments
  for each row execute function app.check_comment_scope();
grant select, insert on app.deliverable_comments to atitude_app;
alter table app.deliverable_comments enable row level security;
create policy deliverable_comments_select on app.deliverable_comments for select to atitude_app
  using (app.can_read_ministry(ministry_id));
create policy deliverable_comments_insert on app.deliverable_comments for insert to atitude_app
  with check (app.can_collaborate(ministry_id));

-- ---------------------------------------------------------------------
-- Investimentos (planejado e realizado). Visibilidade restrita.
-- ---------------------------------------------------------------------
create table app.investments (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  campaign_id uuid references app.campaigns (id) on delete cascade,
  event_id uuid references app.events (id) on delete set null,
  kind text not null check (kind in ('planned', 'realized')),
  category text not null default 'midia_paga'
    check (category in ('midia_paga', 'producao', 'impressao', 'impulsionamento', 'ferramentas', 'outro')),
  description text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  spent_on date,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index investments_ministry_idx on app.investments (ministry_id, kind, spent_on);
create index investments_campaign_idx on app.investments (campaign_id);
create trigger investments_touch before update on app.investments for each row execute function app.touch_updated_at();
create trigger investments_scope before insert or update on app.investments for each row execute function app.enforce_ministry_scope();
grant select, insert, update, delete on app.investments to atitude_app;
select app._apply_ministry_policies('investments',
  'app.can_read_ministry(ministry_id) and app.can_view_investment(ministry_id)');

-- ---------------------------------------------------------------------
-- Metas de campanha
-- ---------------------------------------------------------------------
create table app.campaign_goals (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  label text not null,
  -- Quando informado, o realizado é calculado a partir das métricas observadas.
  metric_key text,
  target_value numeric not null check (target_value >= 0),
  unit text not null default 'count',
  manual_actual_value numeric,
  manual_actual_source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_goals_manual_source check (manual_actual_value is null or manual_actual_source is not null)
);
create index campaign_goals_campaign_idx on app.campaign_goals (campaign_id);
create trigger campaign_goals_touch before update on app.campaign_goals for each row execute function app.touch_updated_at();
create trigger campaign_goals_scope before insert or update on app.campaign_goals for each row execute function app.enforce_ministry_scope();
grant select, insert, update, delete on app.campaign_goals to atitude_app;
select app._apply_ministry_policies('campaign_goals');

-- ---------------------------------------------------------------------
-- Regras de classificação de itens externos (Asana / Meta)
-- ---------------------------------------------------------------------
create table app.mapping_rules (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('asana', 'meta')),
  rule_type text not null check (rule_type in (
    'asana_project', 'asana_section', 'asana_tag', 'asana_custom_field', 'meta_campaign_name_prefix')),
  external_asset_id uuid references app.external_assets (id) on delete cascade,
  -- Para asana_custom_field: GID do campo personalizado.
  match_field text,
  -- Valor a comparar (GID de seção/tag/opção, nome exato ou prefixo).
  match_value text,
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  campaign_id uuid references app.campaigns (id) on delete set null,
  event_id uuid references app.events (id) on delete set null,
  priority integer not null default 100,
  active boolean not null default true,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mapping_rules_value_required check (rule_type = 'asana_project' or match_value is not null),
  constraint mapping_rules_field_required check (rule_type <> 'asana_custom_field' or match_field is not null)
);
create unique index mapping_rules_unique on app.mapping_rules
  (rule_type, coalesce(external_asset_id::text, ''), coalesce(match_field, ''), coalesce(match_value, ''), ministry_id);
create trigger mapping_rules_touch before update on app.mapping_rules for each row execute function app.touch_updated_at();
create trigger mapping_rules_scope before insert or update on app.mapping_rules for each row execute function app.enforce_ministry_scope();
grant select, insert, update, delete on app.mapping_rules to atitude_app;
alter table app.mapping_rules enable row level security;
create policy mapping_rules_select on app.mapping_rules for select to atitude_app using (app.has_global_read());
create policy mapping_rules_write on app.mapping_rules for all to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());
