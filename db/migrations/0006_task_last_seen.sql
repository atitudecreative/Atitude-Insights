-- =====================================================================
-- 0006 Detecção de remoção no Asana independente de edições no portal.
-- =====================================================================
alter table app.tasks add column last_seen_in_source_at timestamptz;
update app.tasks set last_seen_in_source_at = updated_at where source = 'asana';
create index tasks_asana_account_idx on app.tasks (connected_account_id) where source = 'asana';
create index tasks_projects_gin on app.tasks using gin (projects jsonb_path_ops);
grant select (last_seen_in_source_at) on app.tasks to atitude_app;

-- Também é um campo sincronizado: o portal não pode alterá-lo.
create or replace function app.protect_external_task_fields() returns trigger
language plpgsql as $$
begin
  if current_user = 'atitude_app' and old.source <> 'manual' then
    if (new.name, new.notes, new.completed, new.completed_at, new.due_on, new.due_at, new.assignee_name,
        new.section_name, new.tags, new.external_id, new.source, new.permalink_url, new.removed_in_source_at,
        new.last_seen_in_source_at)
       is distinct from
       (old.name, old.notes, old.completed, old.completed_at, old.due_on, old.due_at, old.assignee_name,
        old.section_name, old.tags, old.external_id, old.source, old.permalink_url, old.removed_in_source_at,
        old.last_seen_in_source_at) then
      raise exception 'Campos sincronizados do Asana não podem ser alterados no portal' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
