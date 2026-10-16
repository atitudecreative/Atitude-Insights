import { z } from "zod";
import { sql, type Tx } from "@/server/db";
import { env } from "@/server/env";
import { audit } from "@/server/audit";
import type { Actor } from "@/server/auth/types";
import { hasGlobalRead } from "@/server/auth/types";
import { DEMO_ACCOUNT_EXTERNAL_ID } from "@/server/integrations/demo-account";
import { DEFAULT_SCHEDULE, loadSchedule, type SyncSchedule } from "@/server/integrations/scheduler";
import type { Database } from "@/server/db";
import { asUser, isUuid, ServiceError, zodErrors } from "./context";
import { saveSetting } from "./settings";
import { assertSuperadmin } from "./users";

/**
 * Consultas da área administrativa. Tudo roda com o papel restrito (RLS):
 * superadministradores enxergam o conjunto global pelas próprias políticas.
 */

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
export interface ProviderEnvStatus {
  asana: { oauthConfigured: boolean };
  meta: { appConfigured: boolean };
}

/** Indica apenas SE as variáveis estão definidas (nunca seus valores). */
export function providerEnvStatus(): ProviderEnvStatus {
  const e = env();
  return {
    asana: { oauthConfigured: Boolean(e.ASANA_CLIENT_ID && e.ASANA_CLIENT_SECRET) },
    meta: { appConfigured: Boolean(e.META_APP_ID && e.META_APP_SECRET) },
  };
}

export async function getAdminOverview(actor: Actor) {
  assertSuperadmin(actor);
  return asUser(actor, async (trx) => {
    const counts = await sql<{
      ministries_active: number; ministries_archived: number; ministries_demo: number;
      users_active: number; users_disabled: number; invitations_pending: number;
      unclassified_tasks: number; unclassified_campaigns: number; unclassified_posts: number;
      failed_jobs_24h: number; running_jobs: number;
    }>`
      select
        (select count(*)::int from app.ministries where status = 'active' and not is_demo) as ministries_active,
        (select count(*)::int from app.ministries where status = 'archived' and not is_demo) as ministries_archived,
        (select count(*)::int from app.ministries where is_demo) as ministries_demo,
        (select count(*)::int from app.users where deleted_at is null and status = 'active') as users_active,
        (select count(*)::int from app.users where deleted_at is null and status = 'disabled') as users_disabled,
        (select count(*)::int from app.invitations where kind = 'invite' and accepted_at is null and revoked_at is null and expires_at > now()) as invitations_pending,
        (select count(*)::int from app.tasks where ministry_id is null and removed_in_source_at is null) as unclassified_tasks,
        (select count(*)::int from app.external_campaigns where ministry_id is null) as unclassified_campaigns,
        (select count(*)::int from app.social_posts where ministry_id is null) as unclassified_posts,
        (select count(*)::int from app.sync_jobs where status = 'failed' and finished_at > now() - interval '24 hours') as failed_jobs_24h,
        (select count(*)::int from app.sync_jobs where status in ('queued', 'running')) as running_jobs`.execute(trx);
    // A conta fictícia dos dados de demonstração não entra na contagem.
    const accounts = await trx.selectFrom("app.connected_accounts").select(["provider", "status", (eb) => eb.fn.countAll<number>().as("n")])
      .where((eb) => eb.or([eb("external_user_id", "is", null), eb("external_user_id", "<>", DEMO_ACCOUNT_EXTERNAL_ID)]))
      .groupBy(["provider", "status"]).execute();
    const recentFailures = await trx.selectFrom("app.sync_jobs as j").leftJoin("app.connected_accounts as a", "a.id", "j.connected_account_id")
      .select(["j.id", "j.job_type", "j.error", "j.finished_at", "a.label"])
      .where("j.status", "=", "failed").orderBy("j.finished_at", "desc").limit(5).execute();
    return {
      counts: counts.rows[0]!,
      accounts: accounts.map((a) => ({ provider: a.provider, status: a.status, n: Number(a.n) })),
      recentFailures,
      env: providerEnvStatus(),
    };
  });
}

// ---------------------------------------------------------------------------
// Ministérios (administração)
// ---------------------------------------------------------------------------
export async function listMinistriesAdmin(actor: Actor, opts: { status?: string; demo?: string; q?: string } = {}) {
  assertSuperadmin(actor);
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.ministries as m")
      .select([
        "m.id", "m.slug", "m.name", "m.description", "m.color", "m.logo_url", "m.status", "m.is_demo", "m.created_at", "m.archived_at",
        (eb) => eb.selectFrom("app.ministry_memberships as mm").select(eb.fn.countAll<number>().as("n")).whereRef("mm.ministry_id", "=", "m.id").as("members"),
        (eb) => eb.selectFrom("app.campaigns as c").select(eb.fn.countAll<number>().as("n")).whereRef("c.ministry_id", "=", "m.id").as("campaigns"),
        (eb) => eb.selectFrom("app.asset_ministry_mappings as am").select(eb.fn.countAll<number>().as("n")).whereRef("am.ministry_id", "=", "m.id").as("assets"),
      ]);
    if (opts.status === "active" || opts.status === "archived") q = q.where("m.status", "=", opts.status);
    if (opts.demo === "sim") q = q.where("m.is_demo", "=", true);
    if (opts.demo === "nao") q = q.where("m.is_demo", "=", false);
    if (opts.q) q = q.where("m.name", "ilike", `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const rows = await q.orderBy("m.is_demo").orderBy("m.status").orderBy("m.name").execute();
    return rows.map((r) => ({ ...r, members: Number(r.members ?? 0), campaigns: Number(r.campaigns ?? 0), assets: Number(r.assets ?? 0) }));
  });
}

export async function getMinistryAdmin(actor: Actor, id: string) {
  assertSuperadmin(actor);
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const ministry = await trx.selectFrom("app.ministries")
      .select(["id", "slug", "name", "description", "color", "logo_url", "status", "is_demo", "created_at", "archived_at"])
      .where("id", "=", id).executeTakeFirst();
    if (!ministry) return null;
    const [members, assets, rules, counts] = await Promise.all([
      trx.selectFrom("app.ministry_memberships as mm").innerJoin("app.users as u", "u.id", "mm.user_id")
        .select(["mm.id", "mm.user_id", "mm.role", "mm.can_view_investment", "mm.created_at", "u.name", "u.email", "u.global_role", "u.status"])
        .where("mm.ministry_id", "=", id).where("u.deleted_at", "is", null).orderBy("u.name").execute(),
      trx.selectFrom("app.asset_ministry_mappings as am").innerJoin("app.external_assets as a", "a.id", "am.external_asset_id")
        .innerJoin("app.connected_accounts as ca", "ca.id", "a.connected_account_id")
        .select([
          "am.id as mapping_id", "a.id", "a.name", "a.asset_type", "a.provider", "a.sync_enabled", "a.last_synced_at", "ca.id as account_id", "ca.label as account_label",
          (eb) => eb.selectFrom("app.asset_ministry_mappings as o").select(eb.fn.countAll<number>().as("n")).whereRef("o.external_asset_id", "=", "a.id").as("mapped_ministries"),
        ])
        .where("am.ministry_id", "=", id).orderBy("a.asset_type").orderBy("a.name").execute(),
      trx.selectFrom("app.mapping_rules").select(["id", "provider", "rule_type", "match_value", "priority", "active"]).where("ministry_id", "=", id).orderBy("priority").execute(),
      sql<{ campaigns: number; events: number; tasks: number; deliverables: number }>`
        select (select count(*)::int from app.campaigns where ministry_id = ${id}::uuid) as campaigns,
               (select count(*)::int from app.events where ministry_id = ${id}::uuid) as events,
               (select count(*)::int from app.tasks where ministry_id = ${id}::uuid) as tasks,
               (select count(*)::int from app.deliverables where ministry_id = ${id}::uuid) as deliverables`.execute(trx),
    ]);
    return {
      ministry,
      members,
      assets: assets.map((a) => ({ ...a, mapped_ministries: Number(a.mapped_ministries ?? 0) })),
      rules,
      counts: counts.rows[0]!,
    };
  });
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
const AUDIT_PAGE_SIZE = 40;

export async function listActivity(actor: Actor, opts: { ministryId?: string; action?: string; entityType?: string; visibility?: string; page?: number } = {}) {
  assertSuperadmin(actor);
  const page = opts.page ?? 1;
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.activity_logs as l");
    if (isUuid(opts.ministryId)) q = q.where("l.ministry_id", "=", opts.ministryId);
    if (opts.action) q = q.where("l.action", "=", opts.action);
    if (opts.entityType) q = q.where("l.entity_type", "=", opts.entityType);
    if (opts.visibility === "admin" || opts.visibility === "ministry") q = q.where("l.visibility", "=", opts.visibility);
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q.leftJoin("app.users as u", "u.id", "l.actor_user_id").leftJoin("app.ministries as m", "m.id", "l.ministry_id")
      .select(["l.id", "l.action", "l.entity_type", "l.entity_id", "l.summary", "l.changes", "l.visibility", "l.ip", "l.created_at",
        "u.name as actor_name", "u.email as actor_email", "m.name as ministry_name"])
      .orderBy("l.created_at", "desc").orderBy("l.id", "desc").limit(AUDIT_PAGE_SIZE).offset((page - 1) * AUDIT_PAGE_SIZE).execute();
    const [actions, entityTypes, ministries] = await Promise.all([
      trx.selectFrom("app.activity_logs").select("action").distinct().orderBy("action").limit(200).execute(),
      trx.selectFrom("app.activity_logs").select("entity_type").distinct().orderBy("entity_type").limit(100).execute(),
      trx.selectFrom("app.ministries").select(["id", "name", "is_demo"]).orderBy("name").execute(),
    ]);
    return {
      rows: rows.map((r) => ({ ...r, id: String(r.id) })),
      total: Number(total.n), page, pageSize: AUDIT_PAGE_SIZE,
      options: { actions: actions.map((a) => a.action), entityTypes: entityTypes.map((e) => e.entity_type), ministries },
    };
  });
}

// ---------------------------------------------------------------------------
// Sincronizações
// ---------------------------------------------------------------------------
const JOBS_PAGE_SIZE = 25;

/** Histórico de jobs: visão global (RLS: has_global_read). */
export async function listSyncJobs(actor: Actor, opts: { accountId?: string; status?: string; jobType?: string; page?: number } = {}) {
  if (!hasGlobalRead(actor)) throw new ServiceError("Sem permissão.", "forbidden");
  const page = opts.page ?? 1;
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.sync_jobs as j");
    if (isUuid(opts.accountId)) q = q.where("j.connected_account_id", "=", opts.accountId);
    if (opts.status) q = q.where("j.status", "=", opts.status);
    if (opts.jobType) q = q.where("j.job_type", "=", opts.jobType);
    const total = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const rows = await q.leftJoin("app.connected_accounts as a", "a.id", "j.connected_account_id")
      .leftJoin("app.users as u", "u.id", "j.requested_by")
      .select(["j.id", "j.job_type", "j.provider", "j.status", "j.trigger", "j.attempts", "j.max_attempts", "j.stats", "j.error",
        "j.created_at", "j.started_at", "j.finished_at", "j.run_after", "a.id as account_id", "a.label as account_label", "u.name as requested_by_name"])
      .orderBy("j.created_at", "desc").limit(JOBS_PAGE_SIZE).offset((page - 1) * JOBS_PAGE_SIZE).execute();
    const [accounts, summary] = await Promise.all([
      trx.selectFrom("app.connected_accounts").select(["id", "label", "provider"]).orderBy("label").execute(),
      sql<{ status: string; n: number }>`select status, count(*)::int as n from app.sync_jobs where created_at > now() - interval '7 days' group by status`.execute(trx),
    ]);
    return {
      rows: rows.map((r) => ({ ...r, stats: (r.stats ?? {}) as Record<string, number> })),
      total: Number(total.n), page, pageSize: JOBS_PAGE_SIZE, accounts,
      summary: Object.fromEntries(summary.rows.map((s) => [s.status, s.n])) as Record<string, number>,
    };
  });
}

export async function getSyncJob(actor: Actor, id: string) {
  if (!hasGlobalRead(actor)) throw new ServiceError("Sem permissão.", "forbidden");
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const job = await trx.selectFrom("app.sync_jobs as j").leftJoin("app.connected_accounts as a", "a.id", "j.connected_account_id")
      .leftJoin("app.users as u", "u.id", "j.requested_by")
      .select(["j.id", "j.job_type", "j.provider", "j.status", "j.trigger", "j.attempts", "j.max_attempts", "j.stats", "j.progress", "j.error",
        "j.created_at", "j.started_at", "j.finished_at", "j.run_after", "j.connected_account_id", "a.label as account_label", "a.status as account_status",
        "u.name as requested_by_name"])
      .where("j.id", "=", id).executeTakeFirst();
    if (!job) return null;
    // RLS: sync_logs só é visível para superadministradores (os demais recebem lista vazia).
    const logs = await trx.selectFrom("app.sync_logs").select(["id", "level", "message", "context", "created_at"])
      .where("sync_job_id", "=", id).orderBy("id").limit(500).execute();
    return { job: { ...job, stats: (job.stats ?? {}) as Record<string, number> }, logs: logs.map((l) => ({ ...l, id: String(l.id) })) };
  });
}

export const scheduleInput = z.object({
  asanaIncrementalMinutes: z.coerce.number().int("Use um número inteiro").min(15, "Mínimo de 15 minutos").max(1440, "Máximo de 1440 minutos"),
  asanaFullHours: z.coerce.number().int("Use um número inteiro").min(1, "Mínimo de 1 hora").max(168, "Máximo de 168 horas"),
  metaAdsHours: z.coerce.number().int("Use um número inteiro").min(1, "Mínimo de 1 hora").max(48, "Máximo de 48 horas"),
  metaOrganicHours: z.coerce.number().int("Use um número inteiro").min(1, "Mínimo de 1 hora").max(48, "Máximo de 48 horas"),
});

export async function getSchedule(actor: Actor): Promise<SyncSchedule> {
  if (!hasGlobalRead(actor)) return DEFAULT_SCHEDULE;
  // app_settings é legível pelo papel da aplicação; Tx é compatível com Database.
  return asUser(actor, (trx: Tx) => loadSchedule(trx as unknown as Database));
}

export async function saveSchedule(actor: Actor, raw: unknown): Promise<void> {
  assertSuperadmin(actor);
  const parsed = scheduleInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os intervalos.", "invalid", zodErrors(parsed.error.issues));
  await saveSetting(actor, "sync_schedule", parsed.data);
}

/** Registro de auditoria administrativo genérico (ações sem escrita própria). */
export async function auditAdmin(actor: Actor, entry: Parameters<typeof audit>[1]): Promise<void> {
  await asUser(actor, (trx) => audit(trx, { visibility: "admin", ...entry }));
}
