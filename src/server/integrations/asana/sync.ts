import type { Insertable } from "kysely";
import { sql, type Database } from "@/server/db";
import type { AppTasks, Json } from "@/server/db/schema.generated";
import { classifyAsanaTask, type Classification, type MappingRule } from "../classification";
import { IntegrationError } from "../http";
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from "../jobs";
import type { AsanaTask } from "./client";
import { asanaAuthFromJob, withAsanaAuth, type AsanaAuthContext } from "./service";

/**
 * Sincronização do Asana:
 * - discover: workspaces e projetos (novos projetos entram desabilitados);
 * - incremental: tarefas modificadas desde o último cursor de cada projeto;
 * - full: listagem completa + marcação de tarefas removidas na origem.
 * Todas as gravações são idempotentes (upsert por chave natural).
 */

/** Margem de segurança aplicada ao cursor modified_since. */
const CURSOR_SAFETY_MS = 2 * 60_000;

const json = (value: unknown) => JSON.stringify(value) as unknown as Json;

type Stats = Record<string, number>;
const bump = (stats: Stats, key: string, by = 1) => { stats[key] = (stats[key] ?? 0) + by; };

// ---------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------

/**
 * Upsert de ativo pela chave única (provider, asset_type, external_id).
 * O dono (connected_account_id) só é trocado se a conta atual estiver
 * desconectada/revogada; sync_enabled e sync_cursor nunca são alterados.
 */
async function upsertAsset(
  db: Database,
  values: { accountId: string; assetType: "asana_workspace" | "asana_project"; externalId: string; name: string; parentId: string | null; metadata: Record<string, unknown> },
): Promise<{ id: string; inserted: boolean; connected_account_id: string }> {
  return db.insertInto("app.external_assets").values({
    connected_account_id: values.accountId, provider: "asana", asset_type: values.assetType, external_id: values.externalId,
    name: values.name, parent_asset_id: values.parentId, metadata: json(values.metadata), sync_enabled: false,
  }).onConflict((oc) => oc.columns(["provider", "asset_type", "external_id"]).doUpdateSet({
    name: (eb) => eb.ref("excluded.name"),
    metadata: (eb) => eb.ref("excluded.metadata"),
    parent_asset_id: (eb) => eb.ref("excluded.parent_asset_id"),
    removed_at: null,
    connected_account_id: sql<string>`case when exists (
        select 1 from app.connected_accounts ca
        where ca.id = ${sql.ref("app.external_assets.connected_account_id")} and ca.status in ('disconnected', 'revoked'))
      then excluded.connected_account_id else ${sql.ref("app.external_assets.connected_account_id")} end`,
  })).returning(["id", "connected_account_id", sql<boolean>`(xmax = 0)`.as("inserted")]).executeTakeFirstOrThrow();
}

export const asanaDiscoverHandler: JobHandler = async (ctx) => {
  const { db } = ctx;
  const auth = asanaAuthFromJob(ctx);
  const stats: Stats = { workspaces: 0, projects_found: 0, projects_new: 0, projects_removed: 0 };
  const me = await withAsanaAuth(auth, (client) => client.getMe());
  await db.updateTable("app.connected_accounts").set({ external_user_id: me.gid, external_user_name: me.name })
    .where("id", "=", ctx.account.id).execute();

  const seenWorkspaces: string[] = [];
  for (const workspace of me.workspaces) {
    const ws = await upsertAsset(db, {
      accountId: ctx.account.id, assetType: "asana_workspace", externalId: workspace.gid, name: workspace.name, parentId: null, metadata: {},
    });
    seenWorkspaces.push(workspace.gid);
    bump(stats, "workspaces");
    const projects = await withAsanaAuth(auth, (client) => client.listProjects(workspace.gid));
    const gids: string[] = [];
    for (const project of projects) {
      const asset = await upsertAsset(db, {
        accountId: ctx.account.id, assetType: "asana_project", externalId: project.gid, name: project.name, parentId: ws.id,
        metadata: { archived: project.archived ?? false, team: project.team?.name ?? null, permalink_url: project.permalink_url ?? null, color: project.color ?? null },
      });
      gids.push(project.gid);
      bump(stats, "projects_found");
      if (asset.inserted) bump(stats, "projects_new");
      if (asset.connected_account_id !== ctx.account.id) {
        ctx.log.warn(`Projeto "${project.name}" já pertence a outra conta conectada; mantido na conta original`, { projectGid: project.gid });
      }
    }
    // Projetos que deixaram de ser retornados (arquivados, excluídos ou sem acesso).
    let removal = db.updateTable("app.external_assets").set({ removed_at: new Date() })
      .where("connected_account_id", "=", ctx.account.id).where("asset_type", "=", "asana_project")
      .where("parent_asset_id", "=", ws.id).where("removed_at", "is", null);
    if (gids.length > 0) removal = removal.where("external_id", "not in", gids);
    const removed = await removal.executeTakeFirst();
    bump(stats, "projects_removed", Number(removed.numUpdatedRows));
    ctx.log.info(`Workspace "${workspace.name}": ${projects.length} projeto(s) encontrados`, { workspaceGid: workspace.gid });
  }

  // Workspaces aos quais o usuário não tem mais acesso (e seus projetos).
  let wsRemoval = db.updateTable("app.external_assets").set({ removed_at: new Date() })
    .where("connected_account_id", "=", ctx.account.id).where("asset_type", "=", "asana_workspace").where("removed_at", "is", null);
  if (seenWorkspaces.length > 0) wsRemoval = wsRemoval.where("external_id", "not in", seenWorkspaces);
  const removedWs = await wsRemoval.returning("id").execute();
  if (removedWs.length > 0) {
    const r = await db.updateTable("app.external_assets").set({ removed_at: new Date() })
      .where("parent_asset_id", "in", removedWs.map((w) => w.id)).where("connected_account_id", "=", ctx.account.id)
      .where("removed_at", "is", null).executeTakeFirst();
    bump(stats, "projects_removed", Number(r.numUpdatedRows));
    ctx.log.warn(`${removedWs.length} workspace(s) não estão mais acessíveis`);
  }

  return { status: "succeeded", stats, message: `Descoberta concluída: ${stats.projects_found} projeto(s), ${stats.projects_new} novo(s)` };
};

// ---------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------

interface ClassificationContext {
  rules: MappingRule[];
  assetMinistries: Map<string, string[]>;
  projectAssetByGid: Map<string, string>;
  campaignMinistry: Map<string, string>;
  eventMinistry: Map<string, string>;
}

async function loadClassificationContext(db: Database): Promise<ClassificationContext> {
  const ruleRows = await db.selectFrom("app.mapping_rules")
    .select(["id", "rule_type", "external_asset_id", "match_field", "match_value", "ministry_id", "campaign_id", "event_id", "priority", "active"])
    .where("provider", "=", "asana").where("active", "=", true).execute();
  const rules = ruleRows.map((r) => ({ ...r, rule_type: r.rule_type as MappingRule["rule_type"] }));

  const mappings = await db.selectFrom("app.asset_ministry_mappings as m")
    .innerJoin("app.external_assets as a", "a.id", "m.external_asset_id")
    .select(["m.external_asset_id", "m.ministry_id"]).where("a.provider", "=", "asana").execute();
  const assetMinistries = new Map<string, string[]>();
  for (const m of mappings) assetMinistries.set(m.external_asset_id, [...(assetMinistries.get(m.external_asset_id) ?? []), m.ministry_id]);

  const projects = await db.selectFrom("app.external_assets").select(["id", "external_id"])
    .where("provider", "=", "asana").where("asset_type", "=", "asana_project").execute();
  const projectAssetByGid = new Map(projects.map((p) => [p.external_id, p.id]));

  const campaignIds = [...new Set(rules.map((r) => r.campaign_id).filter((v): v is string => !!v))];
  const eventIds = [...new Set(rules.map((r) => r.event_id).filter((v): v is string => !!v))];
  const campaigns = campaignIds.length > 0
    ? await db.selectFrom("app.campaigns").select(["id", "ministry_id"]).where("id", "in", campaignIds).execute() : [];
  const events = eventIds.length > 0
    ? await db.selectFrom("app.events").select(["id", "ministry_id"]).where("id", "in", eventIds).execute() : [];
  return {
    rules, assetMinistries, projectAssetByGid,
    campaignMinistry: new Map(campaigns.map((c) => [c.id, c.ministry_id])),
    eventMinistry: new Map(events.map((e) => [e.id, e.ministry_id])),
  };
}

function classifyTask(task: AsanaTask, cls: ClassificationContext): Classification {
  const memberships = task.memberships ?? [];
  const projectAssetIds = memberships
    .map((m) => (m.project?.gid ? cls.projectAssetByGid.get(m.project.gid) : undefined))
    .filter((id): id is string => !!id);
  const result = classifyAsanaTask({
    projectAssetIds: [...new Set(projectAssetIds)],
    sectionGids: memberships.map((m) => m.section?.gid).filter((g): g is string => !!g),
    tagGids: (task.tags ?? []).map((t) => t.gid),
    customFields: (task.custom_fields ?? []).map((f) => ({
      gid: f.gid,
      enumOptionGids: [f.enum_value?.gid, ...(f.multi_enum_values ?? []).map((v) => v.gid)].filter((g): g is string => !!g),
      displayValue: f.display_value ?? null,
    })),
  }, cls.rules, cls.assetMinistries);
  // Campanha/evento só quando pertencem ao ministério escolhido (o gatilho
  // tasks_scope rejeitaria vínculos entre ministérios).
  if (result.campaignId && cls.campaignMinistry.get(result.campaignId) !== result.ministryId) result.campaignId = null;
  if (result.eventId && cls.eventMinistry.get(result.eventId) !== result.ministryId) result.eventId = null;
  return result;
}

// ---------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------

function buildTaskRow(task: AsanaTask, projectGid: string, accountId: string, cls: ClassificationContext): Insertable<AppTasks> {
  const memberships = task.memberships ?? [];
  const here = memberships.find((m) => m.project?.gid === projectGid);
  const projects = new Map<string, { gid: string; name: string | null }>();
  for (const m of memberships) {
    if (m.project?.gid && !projects.has(m.project.gid)) projects.set(m.project.gid, { gid: m.project.gid, name: m.project.name ?? null });
  }
  const classification = classifyTask(task, cls);
  return {
    source: "asana",
    external_id: task.gid,
    connected_account_id: accountId,
    name: task.name?.trim() || "(sem título)",
    notes: task.notes ?? null,
    assignee_name: task.assignee?.name ?? null,
    assignee_external_id: task.assignee?.gid ?? null,
    // Status nunca é inferido: concluída apenas com `completed` do Asana.
    completed: task.completed === true,
    completed_at: task.completed === true ? (task.completed_at ?? null) : null,
    due_on: task.due_on ?? null,
    due_at: task.due_at ?? null,
    start_on: task.start_on ?? null,
    created_at_source: task.created_at ?? null,
    modified_at_source: task.modified_at ?? null,
    section_name: here?.section?.name ?? null,
    section_external_id: here?.section?.gid ?? null,
    tags: (task.tags ?? []).map((t) => t.name).filter((n): n is string => !!n),
    projects: json([...projects.values()]),
    custom_fields: json((task.custom_fields ?? []).map((f) => ({
      gid: f.gid, name: f.name, type: f.type ?? null, display_value: f.display_value ?? null,
      enum_option_gids: [f.enum_value?.gid, ...(f.multi_enum_values ?? []).map((v) => v.gid)].filter((g): g is string => !!g),
    }))),
    permalink_url: task.permalink_url ?? null,
    raw: json(task),
    removed_in_source_at: null,
    ministry_id: classification.ministryId,
    campaign_id: classification.campaignId,
    event_id: classification.eventId,
    classification: classification.classification,
    classification_reason: classification.reason,
  };
}

/** Mantém o valor atual quando a classificação foi feita manualmente. */
const keepIfManual = (column: "ministry_id" | "campaign_id" | "event_id" | "classification" | "classification_reason") =>
  sql<string | null>`case when ${sql.ref("app.tasks.classification")} = 'manual' then ${sql.ref(`app.tasks.${column}`)} else ${sql.ref(`excluded.${column}`)} end`;

async function upsertTasks(db: Database, rows: Insertable<AppTasks>[], stats: Stats): Promise<void> {
  if (rows.length === 0) return;
  // Evita "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const unique = [...new Map(rows.map((r) => [r.external_id, r])).values()];
  const result = await db.insertInto("app.tasks").values(unique)
    .onConflict((oc) => oc.columns(["source", "external_id"]).where("external_id", "is not", null).doUpdateSet((eb) => ({
      connected_account_id: eb.ref("excluded.connected_account_id"),
      name: eb.ref("excluded.name"),
      notes: eb.ref("excluded.notes"),
      assignee_name: eb.ref("excluded.assignee_name"),
      assignee_external_id: eb.ref("excluded.assignee_external_id"),
      completed: eb.ref("excluded.completed"),
      completed_at: eb.ref("excluded.completed_at"),
      due_on: eb.ref("excluded.due_on"),
      due_at: eb.ref("excluded.due_at"),
      start_on: eb.ref("excluded.start_on"),
      created_at_source: eb.ref("excluded.created_at_source"),
      modified_at_source: eb.ref("excluded.modified_at_source"),
      section_name: eb.ref("excluded.section_name"),
      section_external_id: eb.ref("excluded.section_external_id"),
      tags: eb.ref("excluded.tags"),
      projects: eb.ref("excluded.projects"),
      custom_fields: eb.ref("excluded.custom_fields"),
      permalink_url: eb.ref("excluded.permalink_url"),
      raw: eb.ref("excluded.raw"),
      removed_in_source_at: null,
      ministry_id: keepIfManual("ministry_id"),
      campaign_id: keepIfManual("campaign_id"),
      event_id: keepIfManual("event_id"),
      classification: sql<string>`${keepIfManual("classification")}`,
      classification_reason: keepIfManual("classification_reason"),
    })))
    .returning(["classification", sql<boolean>`(xmax = 0)`.as("inserted")])
    .execute();
  for (const row of result) {
    bump(stats, row.inserted ? "tasks_created" : "tasks_updated");
    if (row.classification === "unclassified") bump(stats, "tasks_unclassified");
  }
}

// ---------------------------------------------------------------------
// Incremental / completa
// ---------------------------------------------------------------------

type SyncMode = "incremental" | "full";

interface AsanaSyncProgress {
  mode: SyncMode;
  /** Início da sincronização (relógio local), base do próximo modified_since. */
  syncStartedAt: string;
  /** now() do banco no início; tarefas não tocadas desde então não foram vistas. */
  dbStartedAt: string;
  projectIds: string[];
  projectIndex: number;
  offset: string | null;
  failedProjects: number;
  [key: string]: unknown;
}

function parseProgress(raw: Record<string, unknown>, mode: SyncMode): AsanaSyncProgress | null {
  if (raw.mode !== mode || typeof raw.syncStartedAt !== "string" || typeof raw.dbStartedAt !== "string" || !Array.isArray(raw.projectIds)) return null;
  return {
    mode,
    syncStartedAt: raw.syncStartedAt,
    dbStartedAt: raw.dbStartedAt,
    projectIds: raw.projectIds.filter((v): v is string => typeof v === "string"),
    projectIndex: typeof raw.projectIndex === "number" ? raw.projectIndex : 0,
    offset: typeof raw.offset === "string" ? raw.offset : null,
    failedProjects: typeof raw.failedProjects === "number" ? raw.failedProjects : 0,
  };
}

async function startProgress(ctx: JobContext, mode: SyncMode): Promise<AsanaSyncProgress> {
  const projects = await ctx.db.selectFrom("app.external_assets").select("id")
    .where("connected_account_id", "=", ctx.account.id).where("asset_type", "=", "asana_project")
    .where("sync_enabled", "=", true).where("removed_at", "is", null)
    .orderBy("name").orderBy("id").execute();
  const { rows } = await sql<{ now: Date | string }>`select now() as now`.execute(ctx.db);
  const dbNow = rows[0]?.now ?? new Date();
  return {
    mode,
    syncStartedAt: new Date(ctx.http.now()).toISOString(),
    dbStartedAt: new Date(dbNow).toISOString(),
    projectIds: projects.map((p) => p.id),
    projectIndex: 0,
    offset: null,
    failedProjects: 0,
  };
}

function cursorOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Marca como removidas na origem as tarefas do projeto não vistas nesta sincronização completa. */
async function reconcileRemovals(db: Database, accountId: string, projectGid: string, since: string): Promise<number> {
  const result = await db.updateTable("app.tasks").set({ removed_in_source_at: sql<Date>`now()` })
    .where("source", "=", "asana").where("connected_account_id", "=", accountId)
    .where("removed_in_source_at", "is", null)
    .where(sql<boolean>`projects @> ${JSON.stringify([{ gid: projectGid }])}::jsonb`)
    .where("updated_at", "<", new Date(since))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

async function syncProjects(ctx: JobContext, mode: SyncMode): Promise<JobOutcome> {
  const { db } = ctx;
  const auth: AsanaAuthContext = asanaAuthFromJob(ctx);
  const stats: Stats = { tasks_created: 0, tasks_updated: 0, tasks_unclassified: 0, projects_synced: 0 };
  if (mode === "full") stats.tasks_removed = 0;

  let progress = parseProgress(ctx.job.progress, mode);
  if (progress) {
    ctx.log.info(`Retomando do projeto ${progress.projectIndex + 1}/${progress.projectIds.length}`);
  } else {
    progress = await startProgress(ctx, mode);
    if (progress.projectIds.length === 0) {
      return { status: "succeeded", stats, message: "Nenhum projeto do Asana habilitado para sincronização" };
    }
    ctx.log.info(`${progress.projectIds.length} projeto(s) habilitado(s) para sincronização ${mode === "full" ? "completa" : "incremental"}`);
  }
  const cls = await loadClassificationContext(db);
  const nextCursor = new Date(new Date(progress.syncStartedAt).getTime() - CURSOR_SAFETY_MS).toISOString();

  while (progress.projectIndex < progress.projectIds.length) {
    const assetId = progress.projectIds[progress.projectIndex]!;
    const asset = await db.selectFrom("app.external_assets")
      .select(["id", "external_id", "name", "sync_enabled", "removed_at", "sync_cursor", "connected_account_id"])
      .where("id", "=", assetId).executeTakeFirst();
    if (!asset || !asset.sync_enabled || asset.removed_at || asset.connected_account_id !== ctx.account.id) {
      // Desabilitado ou removido depois do início: ignora.
      progress.projectIndex++;
      progress.offset = null;
      continue;
    }
    const cursor = cursorOf(asset.sync_cursor);
    const modifiedSince = mode === "incremental" && typeof cursor.modifiedSince === "string" ? cursor.modifiedSince : undefined;
    const projectStats: Stats = {};
    let offset = progress.offset;
    try {
      for (;;) {
        let page;
        try {
          page = await withAsanaAuth(auth, (client) => client.listTasks({ projectGid: asset.external_id, modifiedSince, offset }));
        } catch (error) {
          // Offsets do Asana expiram: reinicia o projeto do começo (upsert é idempotente).
          if (offset && error instanceof IntegrationError && error.kind === "invalid_request") {
            ctx.log.warn(`Offset de paginação inválido em "${asset.name}"; reiniciando a listagem do projeto`);
            offset = null;
            continue;
          }
          throw error;
        }
        const rows = page.data.map((task) => buildTaskRow(task, asset.external_id, ctx.account.id, cls));
        await upsertTasks(db, rows, projectStats);
        offset = page.nextOffset;
        if (!offset) break;
        if (Date.now() > ctx.deadline) {
          progress.offset = offset;
          await ctx.saveProgress(progress);
          mergeInto(stats, projectStats);
          return { status: "continue", stats };
        }
      }
    } catch (error) {
      if (error instanceof IntegrationError && (error.kind === "not_found" || error.kind === "permission")) {
        if (error.kind === "not_found") {
          await db.updateTable("app.external_assets").set({ removed_at: new Date() }).where("id", "=", asset.id).execute();
          ctx.log.warn(`Projeto "${asset.name}" não existe mais no Asana; marcado como removido`, { projectGid: asset.external_id });
        } else {
          ctx.log.warn(`Sem permissão para ler o projeto "${asset.name}"`, { projectGid: asset.external_id });
        }
        mergeInto(stats, projectStats);
        bump(stats, "projects_failed");
        progress.failedProjects++;
        progress.projectIndex++;
        progress.offset = null;
        continue;
      }
      // Falha temporária/autenticação: guarda o ponto atual para a nova tentativa.
      progress.offset = offset;
      await ctx.saveProgress(progress);
      throw error;
    }

    // Projeto concluído por completo.
    if (mode === "full") {
      const removed = await reconcileRemovals(db, ctx.account.id, asset.external_id, progress.dbStartedAt);
      bump(projectStats, "tasks_removed", removed);
    }
    await db.updateTable("app.external_assets").set({
      sync_cursor: json({ ...cursor, modifiedSince: nextCursor, ...(mode === "full" ? { lastFullSyncAt: progress.syncStartedAt } : {}) }),
      last_synced_at: new Date(),
    }).where("id", "=", asset.id).execute();
    mergeInto(stats, projectStats);
    bump(stats, "projects_synced");
    ctx.log.info(`Projeto "${asset.name}": ${projectStats.tasks_created ?? 0} criada(s), ${projectStats.tasks_updated ?? 0} atualizada(s)`
      + (mode === "full" ? `, ${projectStats.tasks_removed ?? 0} removida(s) na origem` : ""), { projectGid: asset.external_id });

    progress.projectIndex++;
    progress.offset = null;
    if (progress.projectIndex < progress.projectIds.length && Date.now() > ctx.deadline) {
      await ctx.saveProgress(progress);
      return { status: "continue", stats };
    }
  }

  if (progress.failedProjects > 0) {
    return { status: "partial", stats, message: `${progress.failedProjects} projeto(s) não puderam ser sincronizados` };
  }
  return { status: "succeeded", stats, message: `Sincronização ${mode === "full" ? "completa" : "incremental"} do Asana concluída` };
}

function mergeInto(target: Stats, source: Stats) {
  for (const [key, value] of Object.entries(source)) bump(target, key, value);
}

export const asanaIncrementalHandler: JobHandler = (ctx) => syncProjects(ctx, "incremental");
export const asanaFullHandler: JobHandler = (ctx) => syncProjects(ctx, "full");

export const asanaHandlers: JobRegistry = {
  asana_discover: asanaDiscoverHandler,
  asana_incremental: asanaIncrementalHandler,
  asana_full: asanaFullHandler,
};
