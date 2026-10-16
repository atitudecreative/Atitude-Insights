-- =====================================================================
-- 0002 Integrações: contas conectadas (credenciais cifradas), ativos
-- externos, mapeamento ativo ⇄ ministério, fila e logs de sincronização.
-- =====================================================================

create table app.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('asana', 'meta')),
  label text not null,
  auth_type text not null check (auth_type in ('oauth', 'personal_token')),
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'syncing', 'error', 'expired', 'revoked', 'disconnected')),
  -- AES-256-GCM (ver src/server/security/crypto.ts). Nunca concedido ao papel da aplicação.
  credentials_encrypted text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  external_user_id text,
  external_user_name text,
  sync_enabled boolean not null default true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_error text,
  last_error_at timestamptz,
  last_sync_at timestamptz,
  last_successful_sync_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger connected_accounts_touch before update on app.connected_accounts
  for each row execute function app.touch_updated_at();

create table app.oauth_states (
  state_hash text primary key,
  provider text not null check (provider in ('asana', 'meta')),
  user_id uuid not null references app.users (id) on delete cascade,
  code_verifier text,
  label text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table app.external_assets (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references app.connected_accounts (id) on delete cascade,
  provider text not null check (provider in ('asana', 'meta')),
  asset_type text not null check (asset_type in (
    'asana_workspace', 'asana_project', 'meta_ad_account', 'facebook_page', 'instagram_account')),
  external_id text not null,
  name text not null,
  parent_asset_id uuid references app.external_assets (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  sync_enabled boolean not null default false,
  last_synced_at timestamptz,
  -- Para sincronização incremental (ex.: modified_since do Asana).
  sync_cursor jsonb not null default '{}'::jsonb,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, asset_type, external_id)
);
create index external_assets_account_idx on app.external_assets (connected_account_id);
create trigger external_assets_touch before update on app.external_assets
  for each row execute function app.touch_updated_at();

-- Ativo externo ⇄ ministério. Um ativo pode servir vários ministérios;
-- a classificação automática só ocorre quando existe exatamente um vínculo.
create table app.asset_ministry_mappings (
  id uuid primary key default gen_random_uuid(),
  external_asset_id uuid not null references app.external_assets (id) on delete cascade,
  ministry_id uuid not null references app.ministries (id) on delete cascade,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (external_asset_id, ministry_id)
);
create index asset_ministry_mappings_ministry_idx on app.asset_ministry_mappings (ministry_id);

-- Disponibilidade real de métricas por ativo (a API varia por conta/tipo).
create table app.metric_availability (
  id uuid primary key default gen_random_uuid(),
  external_asset_id uuid not null references app.external_assets (id) on delete cascade,
  metric_key text not null,
  scope text not null default 'default',
  available boolean not null,
  reason text,
  checked_at timestamptz not null default now(),
  unique (external_asset_id, metric_key, scope)
);

create table app.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid references app.connected_accounts (id) on delete cascade,
  provider text not null check (provider in ('asana', 'meta')),
  job_type text not null check (job_type in (
    'asana_discover', 'asana_incremental', 'asana_full', 'meta_discover', 'meta_ads', 'meta_organic')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'retry', 'system')),
  requested_by uuid references app.users (id) on delete set null,
  run_after timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_until timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  progress jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Evita jobs duplicados ativos para a mesma conta/tipo.
create unique index sync_jobs_one_active on app.sync_jobs (connected_account_id, job_type)
  where status in ('queued', 'running');
create index sync_jobs_queue_idx on app.sync_jobs (status, run_after);
create index sync_jobs_account_idx on app.sync_jobs (connected_account_id, created_at desc);
create trigger sync_jobs_touch before update on app.sync_jobs
  for each row execute function app.touch_updated_at();

create table app.sync_logs (
  id bigint generated always as identity primary key,
  sync_job_id uuid not null references app.sync_jobs (id) on delete cascade,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sync_logs_job_idx on app.sync_logs (sync_job_id, id);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table app.connected_accounts enable row level security;
alter table app.oauth_states enable row level security;
alter table app.external_assets enable row level security;
alter table app.asset_ministry_mappings enable row level security;
alter table app.metric_availability enable row level security;
alter table app.sync_jobs enable row level security;
alter table app.sync_logs enable row level security;

-- credentials_encrypted fica fora do GRANT: nem superadmins conseguem lê-la
-- por meio do papel da aplicação.
grant select (id, provider, label, auth_type, status, token_expires_at, scopes, external_user_id,
              external_user_name, sync_enabled, last_tested_at, last_test_ok, last_error, last_error_at,
              last_sync_at, last_successful_sync_at, created_by, created_at, updated_at)
  on app.connected_accounts to atitude_app;
grant update (label, sync_enabled) on app.connected_accounts to atitude_app;
create policy connected_accounts_select on app.connected_accounts for select to atitude_app
  using (app.has_global_read());
create policy connected_accounts_update on app.connected_accounts for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());

grant select (id, connected_account_id, provider, asset_type, external_id, name, parent_asset_id, metadata,
              sync_enabled, last_synced_at, removed_at, created_at, updated_at)
  on app.external_assets to atitude_app;
grant update (sync_enabled) on app.external_assets to atitude_app;
create policy external_assets_select on app.external_assets for select to atitude_app
  using (app.has_global_read() or exists (
    select 1 from app.asset_ministry_mappings m
    where m.external_asset_id = external_assets.id and app.can_read_ministry(m.ministry_id)));
create policy external_assets_update on app.external_assets for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());

grant select, insert, delete on app.asset_ministry_mappings to atitude_app;
create policy asset_mappings_select on app.asset_ministry_mappings for select to atitude_app
  using (app.has_global_read() or app.can_read_ministry(ministry_id));
create policy asset_mappings_insert on app.asset_ministry_mappings for insert to atitude_app
  with check (app.is_superadmin());
create policy asset_mappings_delete on app.asset_ministry_mappings for delete to atitude_app
  using (app.is_superadmin());

grant select on app.metric_availability to atitude_app;
create policy metric_availability_select on app.metric_availability for select to atitude_app
  using (app.has_global_read() or exists (
    select 1 from app.asset_ministry_mappings m
    where m.external_asset_id = metric_availability.external_asset_id and app.can_read_ministry(m.ministry_id)));

grant select, insert, update on app.sync_jobs to atitude_app;
create policy sync_jobs_select on app.sync_jobs for select to atitude_app using (app.has_global_read());
create policy sync_jobs_insert on app.sync_jobs for insert to atitude_app with check (app.is_superadmin());
create policy sync_jobs_update on app.sync_jobs for update to atitude_app
  using (app.is_superadmin()) with check (app.is_superadmin());

grant select on app.sync_logs to atitude_app;
create policy sync_logs_select on app.sync_logs for select to atitude_app using (app.is_superadmin());
-- oauth_states: somente sistema.
