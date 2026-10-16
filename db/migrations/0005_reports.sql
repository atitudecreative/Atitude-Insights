-- =====================================================================
-- 0005 Relatórios de prestação de contas e versões congeladas.
-- =====================================================================

create table app.reports (
  id uuid primary key default gen_random_uuid(),
  -- null = relatório consolidado da agência (somente visão global).
  ministry_id uuid references app.ministries (id) on delete cascade,
  scope_type text not null check (scope_type in ('ministry', 'campaign', 'event', 'agency')),
  campaign_id uuid references app.campaigns (id) on delete cascade,
  event_id uuid references app.events (id) on delete cascade,
  channel_key text,
  period_start date not null,
  period_end date not null,
  title text not null check (length(title) between 3 and 200),
  status text not null default 'draft' check (status in ('draft', 'published')),
  objectives text,
  executive_summary text,
  learnings text,
  observations text,
  created_by uuid references app.users (id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_period check (period_end >= period_start),
  constraint reports_scope check (
    (scope_type = 'agency' and ministry_id is null and campaign_id is null and event_id is null)
    or (scope_type = 'ministry' and ministry_id is not null and campaign_id is null and event_id is null)
    or (scope_type = 'campaign' and ministry_id is not null and campaign_id is not null)
    or (scope_type = 'event' and ministry_id is not null and event_id is not null))
);
create index reports_ministry_idx on app.reports (ministry_id, created_at desc);
create trigger reports_touch before update on app.reports for each row execute function app.touch_updated_at();
create trigger reports_scope before insert or update on app.reports for each row execute function app.enforce_ministry_scope();
create trigger reports_lock_ministry before update on app.reports for each row execute function app.prevent_ministry_change();

create table app.report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references app.reports (id) on delete cascade,
  ministry_id uuid references app.ministries (id) on delete cascade,
  version integer not null check (version > 0),
  -- Dados congelados SEM valores monetários.
  snapshot jsonb not null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (report_id, version)
);

-- Seção financeira separada para aplicar a permissão de investimento via RLS.
create table app.report_version_financials (
  report_version_id uuid primary key references app.report_versions (id) on delete cascade,
  ministry_id uuid references app.ministries (id) on delete cascade,
  data jsonb not null
);

create or replace function app.check_report_financial_scope() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if (select ministry_id from app.report_versions where id = new.report_version_id) is distinct from new.ministry_id then
    raise exception 'Versão fora do escopo do relatório' using errcode = '23514';
  end if;
  return new;
end;
$$;
create or replace function app.check_report_version_parent() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if (select ministry_id from app.reports where id = new.report_id) is distinct from new.ministry_id then
    raise exception 'Versão fora do escopo do relatório' using errcode = '23514';
  end if;
  new.created_by := coalesce(app.current_user_id(), new.created_by);
  return new;
end;
$$;
create trigger report_versions_scope before insert on app.report_versions
  for each row execute function app.check_report_version_parent();
create trigger report_version_financials_scope before insert on app.report_version_financials
  for each row execute function app.check_report_financial_scope();

alter table app.reports enable row level security;
alter table app.report_versions enable row level security;
alter table app.report_version_financials enable row level security;
grant select, insert, update, delete on app.reports to atitude_app;
grant select, insert on app.report_versions, app.report_version_financials to atitude_app;

-- Rascunhos: apenas quem gerencia. Publicados: todos com leitura no escopo.
create policy reports_select on app.reports for select to atitude_app
  using (app.can_manage_ministry(ministry_id) or (status = 'published' and app.can_read_ministry(ministry_id)));
create policy reports_insert on app.reports for insert to atitude_app with check (app.can_manage_ministry(ministry_id));
create policy reports_update on app.reports for update to atitude_app
  using (app.can_manage_ministry(ministry_id)) with check (app.can_manage_ministry(ministry_id));
create policy reports_delete on app.reports for delete to atitude_app using (app.can_manage_ministry(ministry_id));

create policy report_versions_select on app.report_versions for select to atitude_app
  using (exists (select 1 from app.reports r where r.id = report_versions.report_id));
create policy report_versions_insert on app.report_versions for insert to atitude_app
  with check (app.can_manage_ministry(ministry_id));
create policy report_version_financials_select on app.report_version_financials for select to atitude_app
  using (app.can_read_ministry(ministry_id) and app.can_view_investment(ministry_id)
         and exists (select 1 from app.report_versions v where v.id = report_version_financials.report_version_id));
create policy report_version_financials_insert on app.report_version_financials for insert to atitude_app
  with check (app.can_manage_ministry(ministry_id));
