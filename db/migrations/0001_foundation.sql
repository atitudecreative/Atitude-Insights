-- =====================================================================
-- Atitude Insights — 0001 Fundação: schema, papel de aplicação, usuários,
-- sessões, ministérios, vínculos e funções de autorização (RLS).
--
-- Modelo de segurança:
--   * Todas as tabelas vivem no schema `app` (não exposto por PostgREST).
--   * O dono das tabelas (usuário de migração) é usado apenas por processos
--     de sistema (autenticação, sincronização). Consultas originadas por
--     usuários executam com `SET LOCAL ROLE atitude_app`, um papel SEM
--     BYPASSRLS, e com `app.user_id` definido na transação.
--   * As políticas RLS usam funções SECURITY DEFINER que verificam a
--     associação explícita usuário ⇄ ministério e o status do usuário.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'atitude_app') then
    create role atitude_app nologin nobypassrls;
  end if;
end
$$;

-- O usuário de conexão precisa poder assumir o papel restrito.
grant atitude_app to current_user;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to atitude_app;

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Usuários e autenticação
-- ---------------------------------------------------------------------
create table app.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text,
  global_role text not null default 'ministry'
    check (global_role in ('superadmin', 'agency', 'ministry')),
  -- Visão operacional global da agência (somente para global_role = 'agency').
  agency_global_access text not null default 'none'
    check (agency_global_access in ('none', 'read', 'manage')),
  status text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  avatar_url text,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint users_email_lowercase check (email = lower(email)),
  constraint users_agency_access_only_for_agency
    check (global_role = 'agency' or agency_global_access = 'none')
);
create unique index users_email_key on app.users (email) where deleted_at is null;
create trigger users_touch before update on app.users
  for each row execute function app.touch_updated_at();

create table app.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index sessions_user_idx on app.sessions (user_id) where revoked_at is null;

create table app.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

-- ---------------------------------------------------------------------
-- Ministérios
-- ---------------------------------------------------------------------
create table app.ministries (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  description text,
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  logo_url text,
  status text not null default 'active' check (status in ('active', 'archived')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint ministries_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
create unique index ministries_slug_key on app.ministries (slug);
create trigger ministries_touch before update on app.ministries
  for each row execute function app.touch_updated_at();

create table app.ministry_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  role text not null check (role in ('agency_manager', 'agency_viewer', 'leader', 'operational')),
  can_view_investment boolean not null default false,
  created_by uuid references app.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ministry_id)
);
create index ministry_memberships_ministry_idx on app.ministry_memberships (ministry_id);
create trigger ministry_memberships_touch before update on app.ministry_memberships
  for each row execute function app.touch_updated_at();

-- Vínculos de agência só podem ser atribuídos a usuários da agência e
-- vínculos de liderança/operação somente a usuários de ministério.
create or replace function app.check_membership_role() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_role text;
begin
  select global_role into v_role from app.users where id = new.user_id;
  if v_role = 'superadmin' then
    raise exception 'Superadministradores não precisam de vínculo com ministérios';
  end if;
  if new.role in ('agency_manager', 'agency_viewer') and v_role <> 'agency' then
    raise exception 'Papel de agência exige usuário da agência';
  end if;
  if new.role in ('leader', 'operational') and v_role <> 'ministry' then
    raise exception 'Papel de ministério exige usuário de ministério';
  end if;
  return new;
end;
$$;
create trigger ministry_memberships_check before insert or update on app.ministry_memberships
  for each row execute function app.check_membership_role();

create table app.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  name text not null,
  token_hash text not null unique,
  global_role text not null check (global_role in ('superadmin', 'agency', 'ministry')),
  agency_global_access text not null default 'none'
    check (agency_global_access in ('none', 'read', 'manage')),
  ministry_id uuid references app.ministries (id) on delete cascade,
  ministry_role text check (ministry_role in ('agency_manager', 'agency_viewer', 'leader', 'operational')),
  can_view_investment boolean not null default false,
  invited_by uuid references app.users (id),
  user_id uuid references app.users (id) on delete cascade,
  kind text not null default 'invite' check (kind in ('invite', 'password_reset')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_email_idx on app.invitations (email);

-- ---------------------------------------------------------------------
-- Funções de autorização (base das políticas RLS)
-- ---------------------------------------------------------------------
create or replace function app.current_global_role() returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select u.global_role
  from app.users u
  where u.id = app.current_user_id() and u.status = 'active' and u.deleted_at is null
$$;

create or replace function app.is_superadmin() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(app.current_global_role() = 'superadmin', false)
$$;

create or replace function app.has_global_read() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.users u
    where u.id = app.current_user_id() and u.status = 'active' and u.deleted_at is null
      and (u.global_role = 'superadmin'
           or (u.global_role = 'agency' and u.agency_global_access in ('read', 'manage')))
  )
$$;

create or replace function app.has_global_manage() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.users u
    where u.id = app.current_user_id() and u.status = 'active' and u.deleted_at is null
      and (u.global_role = 'superadmin'
           or (u.global_role = 'agency' and u.agency_global_access = 'manage'))
  )
$$;

create or replace function app.membership_role(p_ministry uuid) returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select m.role
  from app.ministry_memberships m
  join app.users u on u.id = m.user_id
  where m.user_id = app.current_user_id() and m.ministry_id = p_ministry
    and u.status = 'active' and u.deleted_at is null
$$;

create or replace function app.can_read_ministry(p_ministry uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.has_global_read() or (p_ministry is not null and app.membership_role(p_ministry) is not null)
$$;

create or replace function app.can_manage_ministry(p_ministry uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.has_global_manage()
      or (p_ministry is not null and app.membership_role(p_ministry) = 'agency_manager')
$$;

create or replace function app.can_view_investment(p_ministry uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.has_global_read()
      or (p_ministry is not null and exists (
        select 1 from app.ministry_memberships m
        join app.users u on u.id = m.user_id
        where m.user_id = app.current_user_id() and m.ministry_id = p_ministry
          and u.status = 'active' and u.deleted_at is null
          and (m.role in ('agency_manager', 'agency_viewer') or m.can_view_investment)
      ))
$$;

-- Ações operacionais do ministério (aprovar/comentar entregáveis).
create or replace function app.can_collaborate(p_ministry uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.can_manage_ministry(p_ministry)
      or (p_ministry is not null and app.membership_role(p_ministry) = 'operational')
$$;

create or replace function app.can_see_user(p_user uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select p_user = app.current_user_id()
      or app.current_global_role() in ('superadmin', 'agency')
      or exists (
        select 1 from app.ministry_memberships mine
        join app.ministry_memberships theirs on theirs.ministry_id = mine.ministry_id
        where mine.user_id = app.current_user_id() and theirs.user_id = p_user
      )
$$;

revoke all on all functions in schema app from public;
grant execute on function
  app.current_user_id(), app.current_global_role(), app.is_superadmin(), app.has_global_read(),
  app.has_global_manage(), app.membership_role(uuid), app.can_read_ministry(uuid),
  app.can_manage_ministry(uuid), app.can_view_investment(uuid), app.can_collaborate(uuid),
  app.can_see_user(uuid)
to atitude_app;

-- ---------------------------------------------------------------------
-- RLS — usuários, ministérios e vínculos
-- ---------------------------------------------------------------------
alter table app.users enable row level security;
alter table app.sessions enable row level security;
alter table app.rate_limits enable row level security;
alter table app.invitations enable row level security;
alter table app.ministries enable row level security;
alter table app.ministry_memberships enable row level security;

-- password_hash NUNCA é legível pelo papel da aplicação.
grant select (id, email, name, global_role, agency_global_access, status, avatar_url,
              last_login_at, created_at, updated_at, deleted_at)
  on app.users to atitude_app;
grant update (name, global_role, agency_global_access, status, avatar_url, deleted_at)
  on app.users to atitude_app;

create policy users_select on app.users for select to atitude_app
  using (app.can_see_user(id));
create policy users_update on app.users for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());

-- Convites: somente leitura administrativa (escrita pelo serviço de sistema).
grant select (id, email, name, global_role, agency_global_access, ministry_id, ministry_role,
              can_view_investment, invited_by, user_id, kind, expires_at, accepted_at, revoked_at,
              created_at)
  on app.invitations to atitude_app;
create policy invitations_select on app.invitations for select to atitude_app
  using (app.is_superadmin());

grant select, insert, update on app.ministries to atitude_app;
create policy ministries_select on app.ministries for select to atitude_app
  using (app.can_read_ministry(id));
create policy ministries_insert on app.ministries for insert to atitude_app
  with check (app.is_superadmin());
create policy ministries_update on app.ministries for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());

grant select, insert, update, delete on app.ministry_memberships to atitude_app;
create policy memberships_select on app.ministry_memberships for select to atitude_app
  using (user_id = app.current_user_id() or app.is_superadmin() or app.can_manage_ministry(ministry_id));
create policy memberships_insert on app.ministry_memberships for insert to atitude_app
  with check (app.is_superadmin());
create policy memberships_update on app.ministry_memberships for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());
create policy memberships_delete on app.ministry_memberships for delete to atitude_app
  using (app.is_superadmin());
-- sessions e rate_limits: sem GRANT ao papel da aplicação (somente sistema).

-- ---------------------------------------------------------------------
-- Auditoria (append-only; escrita apenas via função)
-- ---------------------------------------------------------------------
create table app.activity_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references app.users (id) on delete set null,
  ministry_id uuid references app.ministries (id) on delete cascade,
  entity_type text not null,
  entity_id text,
  action text not null,
  summary text,
  changes jsonb not null default '{}'::jsonb,
  -- 'ministry' = visível no histórico do ministério; 'admin' = auditoria de segurança.
  visibility text not null default 'ministry' check (visibility in ('ministry', 'admin')),
  ip text,
  created_at timestamptz not null default now()
);
create index activity_logs_ministry_idx on app.activity_logs (ministry_id, created_at desc);
create index activity_logs_entity_idx on app.activity_logs (entity_type, entity_id);
alter table app.activity_logs enable row level security;
grant select on app.activity_logs to atitude_app;
create policy activity_logs_select on app.activity_logs for select to atitude_app
  using (app.is_superadmin()
         or (visibility = 'ministry' and ministry_id is not null and app.can_read_ministry(ministry_id))
         or (visibility = 'ministry' and ministry_id is null and app.has_global_read()));

create or replace function app.log_activity(
  p_ministry uuid, p_entity_type text, p_entity_id text, p_action text,
  p_summary text, p_changes jsonb default '{}'::jsonb, p_visibility text default 'ministry'
) returns void
language sql security definer set search_path = app, pg_temp as $$
  insert into app.activity_logs (actor_user_id, ministry_id, entity_type, entity_id, action, summary, changes, visibility)
  values (app.current_user_id(), p_ministry, p_entity_type, p_entity_id, p_action, p_summary,
          coalesce(p_changes, '{}'::jsonb), coalesce(p_visibility, 'ministry'));
$$;
revoke all on function app.log_activity(uuid, text, text, text, text, jsonb, text) from public;
grant execute on function app.log_activity(uuid, text, text, text, text, jsonb, text) to atitude_app;

-- ---------------------------------------------------------------------
-- Configurações gerais (identidade visual, sincronização etc.)
-- ---------------------------------------------------------------------
create table app.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table app.app_settings enable row level security;
grant select, insert, update on app.app_settings to atitude_app;
create policy app_settings_select on app.app_settings for select to atitude_app using (true);
create policy app_settings_insert on app.app_settings for insert to atitude_app with check (app.is_superadmin());
create policy app_settings_update on app.app_settings for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());
