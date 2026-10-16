import type { Database } from "@/server/db";
import { enqueueJob, type JobType } from "./jobs";

export interface SyncSchedule {
  asanaIncrementalMinutes: number;
  asanaFullHours: number;
  metaAdsHours: number;
  metaOrganicHours: number;
}

export const DEFAULT_SCHEDULE: SyncSchedule = {
  asanaIncrementalMinutes: 60,
  asanaFullHours: 24,
  metaAdsHours: 6,
  metaOrganicHours: 6,
};

export async function loadSchedule(db: Database): Promise<SyncSchedule> {
  const row = await db.selectFrom("app.app_settings").select("value").where("key", "=", "sync_schedule").executeTakeFirst();
  return { ...DEFAULT_SCHEDULE, ...((row?.value as Partial<SyncSchedule> | undefined) ?? {}) };
}

/**
 * Enfileira jobs vencidos para contas ativas. Idempotente: o índice único
 * impede duplicar jobs ativos e o último job concluído define o intervalo.
 */
export async function enqueueDueJobs(db: Database, now = new Date()): Promise<number> {
  const schedule = await loadSchedule(db);
  const accounts = await db.selectFrom("app.connected_accounts").select(["id", "provider"])
    .where("sync_enabled", "=", true).where("status", "in", ["connected", "error", "syncing"]).execute();
  const plan: Record<"asana" | "meta", Array<{ type: JobType; everyMs: number }>> = {
    asana: [
      { type: "asana_incremental", everyMs: schedule.asanaIncrementalMinutes * 60_000 },
      { type: "asana_full", everyMs: schedule.asanaFullHours * 3600_000 },
    ],
    meta: [
      { type: "meta_ads", everyMs: schedule.metaAdsHours * 3600_000 },
      { type: "meta_organic", everyMs: schedule.metaOrganicHours * 3600_000 },
    ],
  };
  let created = 0;
  for (const account of accounts) {
    for (const item of plan[account.provider as "asana" | "meta"] ?? []) {
      const last = await db.selectFrom("app.sync_jobs").select("created_at")
        .where("connected_account_id", "=", account.id).where("job_type", "=", item.type)
        .orderBy("created_at", "desc").limit(1).executeTakeFirst();
      if (last && now.getTime() - new Date(last.created_at).getTime() < item.everyMs) continue;
      const result = await enqueueJob(db, { accountId: account.id, provider: account.provider as "asana" | "meta", jobType: item.type, trigger: "schedule" });
      if (result.created) created++;
    }
  }
  return created;
}
