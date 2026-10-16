import { sql, type Database } from "@/server/db";
import type { Json } from "@/server/db/schema.generated";
import { redactSecrets } from "@/server/security/crypto";
import { loadCredentials, type KeyRing, type StoredCredentials } from "./credentials";
import { defaultHttpDeps, IntegrationError, type HttpDeps } from "./http";

export type JobType = "asana_discover" | "asana_incremental" | "asana_full" | "meta_discover" | "meta_ads" | "meta_organic";

export interface SyncJobRow {
  id: string;
  connected_account_id: string | null;
  provider: string;
  job_type: JobType;
  attempts: number;
  max_attempts: number;
  progress: Record<string, unknown>;
  stats: Record<string, number>;
}

export interface AccountRow {
  id: string;
  provider: "asana" | "meta";
  label: string;
  auth_type: string;
}

export class JobLogger {
  private buffer: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; context: Record<string, unknown> }> = [];
  constructor(private readonly db: Database, private readonly jobId: string) {}

  info(message: string, context: Record<string, unknown> = {}) { this.push("info", message, context); }
  warn(message: string, context: Record<string, unknown> = {}) { this.push("warn", message, context); }
  error(message: string, context: Record<string, unknown> = {}) { this.push("error", message, context); }

  private push(level: "debug" | "info" | "warn" | "error", message: string, context: Record<string, unknown>) {
    const safeContext = JSON.parse(redactSecrets(JSON.stringify(context))) as Record<string, unknown>;
    this.buffer.push({ level, message: redactSecrets(message).slice(0, 2000), context: safeContext });
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0);
    await this.db.insertInto("app.sync_logs").values(rows.map((r) => ({
      sync_job_id: this.jobId, level: r.level, message: r.message, context: JSON.stringify(r.context) as unknown as Json,
    }))).execute();
  }
}

export interface JobContext {
  db: Database;
  job: SyncJobRow;
  account: AccountRow;
  credentials: StoredCredentials;
  keys: KeyRing;
  log: JobLogger;
  http: HttpDeps;
  /** Instante (ms) a partir do qual o job deve salvar o progresso e parar. */
  deadline: number;
  saveProgress: (progress: Record<string, unknown>) => Promise<void>;
  graphVersion: string;
  config: IntegrationConfig;
}

/** Configuração não sensível ao navegador, injetada pelo servidor. */
export interface IntegrationConfig {
  metaAppId?: string;
  metaAppSecret?: string;
  asanaClientId?: string;
  asanaClientSecret?: string;
}

export interface JobOutcome {
  /** continue = prazo atingido; progresso salvo e job reenfileirado. */
  status: "succeeded" | "partial" | "continue";
  stats?: Record<string, number>;
  message?: string;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;
export type JobRegistry = Partial<Record<JobType, JobHandler>>;

/** Enfileira um job; se já houver um ativo do mesmo tipo/conta, retorna o existente. */
export async function enqueueJob(
  db: Database,
  input: { accountId: string; provider: "asana" | "meta"; jobType: JobType; trigger?: "manual" | "schedule" | "retry" | "system"; requestedBy?: string | null; runAfter?: Date },
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insertInto("app.sync_jobs")
    .values({
      connected_account_id: input.accountId, provider: input.provider, job_type: input.jobType,
      trigger: input.trigger ?? "manual", requested_by: input.requestedBy ?? null, run_after: input.runAfter ?? new Date(),
    })
    .onConflict((oc) => oc.columns(["connected_account_id", "job_type"]).where("status", "in", ["queued", "running"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, created: true };
  const existing = await db.selectFrom("app.sync_jobs").select("id")
    .where("connected_account_id", "=", input.accountId).where("job_type", "=", input.jobType)
    .where("status", "in", ["queued", "running"]).executeTakeFirstOrThrow();
  return { id: existing.id, created: false };
}

/** Reivindica o próximo job (concorrência segura com SKIP LOCKED; recupera jobs travados). */
export async function claimNextJob(db: Database, lockMinutes = 10): Promise<SyncJobRow | null> {
  const result = await sql<SyncJobRow>`
    update app.sync_jobs set status = 'running', started_at = coalesce(started_at, now()),
      locked_until = now() + make_interval(mins => ${lockMinutes}), attempts = attempts + 1
    where id = (
      select id from app.sync_jobs
      where (status = 'queued' and run_after <= now()) or (status = 'running' and locked_until < now())
      order by run_after
      limit 1
      for update skip locked)
    returning id, connected_account_id, provider, job_type, attempts, max_attempts, progress, stats`.execute(db);
  return result.rows[0] ?? null;
}

function mergeStats(a: Record<string, number>, b: Record<string, number> = {}): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export interface RunOptions {
  registry: JobRegistry;
  keys: KeyRing;
  http?: HttpDeps;
  graphVersion?: string;
  jobBudgetMs?: number;
  config?: IntegrationConfig;
}

/** Executa um job reivindicado, tratando sucesso, continuação e falhas. */
export async function runJob(db: Database, job: SyncJobRow, options: RunOptions): Promise<JobOutcome | { status: "failed" | "retry"; error: string }> {
  const log = new JobLogger(db, job.id);
  const handler = options.registry[job.job_type];
  const finish = async (status: "succeeded" | "partial" | "failed" | "cancelled", patch: { stats?: Record<string, number>; error?: string | null } = {}) => {
    await db.updateTable("app.sync_jobs").set({
      status, finished_at: new Date(), locked_until: null,
      stats: JSON.stringify(patch.stats ?? job.stats) as unknown as Json, error: patch.error ?? null,
    }).where("id", "=", job.id).execute();
  };

  if (!job.connected_account_id || !handler) {
    log.error("Job sem conta ou tipo não suportado", { jobType: job.job_type });
    await log.flush();
    await finish("failed", { error: "Tipo de job não suportado" });
    return { status: "failed", error: "Tipo de job não suportado" };
  }

  const account = await db.selectFrom("app.connected_accounts").select(["id", "provider", "label", "auth_type", "status"])
    .where("id", "=", job.connected_account_id).executeTakeFirst();
  if (!account || account.status === "disconnected" || account.status === "revoked") {
    await finish("cancelled", { error: "Conta desconectada" });
    return { status: "failed", error: "Conta desconectada" };
  }

  let credentials: StoredCredentials | null;
  try {
    credentials = await loadCredentials(db, account.id, options.keys);
  } catch (error) {
    credentials = null;
    log.error((error as Error).message);
  }
  if (!credentials) {
    log.error("Credenciais ausentes ou ilegíveis");
    await log.flush();
    await finish("failed", { error: "Credenciais ausentes" });
    await db.updateTable("app.connected_accounts").set({ status: "error", last_error: "Credenciais ausentes ou ilegíveis", last_error_at: new Date() })
      .where("id", "=", account.id).execute();
    return { status: "failed", error: "Credenciais ausentes" };
  }

  await db.updateTable("app.connected_accounts").set({ status: "syncing" }).where("id", "=", account.id).execute();
  log.info(`Início (${job.job_type}), tentativa ${job.attempts}`);

  const ctx: JobContext = {
    db, job, credentials, log, keys: options.keys,
    account: { id: account.id, provider: account.provider as "asana" | "meta", label: account.label, auth_type: account.auth_type },
    http: options.http ?? defaultHttpDeps,
    deadline: Date.now() + (options.jobBudgetMs ?? 240_000),
    graphVersion: options.graphVersion ?? "v23.0",
    config: options.config ?? {},
    saveProgress: async (progress) => {
      job.progress = progress;
      await db.updateTable("app.sync_jobs").set({ progress: JSON.stringify(progress) as unknown as Json, locked_until: sql<Date>`now() + interval '10 minutes'` })
        .where("id", "=", job.id).execute();
    },
  };

  try {
    const outcome = await handler(ctx);
    const stats = mergeStats(job.stats, outcome.stats);
    if (outcome.status === "continue") {
      log.info("Prazo de execução atingido; progresso salvo e job reenfileirado", { stats: outcome.stats });
      await log.flush();
      await db.updateTable("app.sync_jobs").set({
        status: "queued", run_after: new Date(), locked_until: null, attempts: sql<number>`greatest(attempts - 1, 0)`,
        stats: JSON.stringify(stats) as unknown as Json,
      }).where("id", "=", job.id).execute();
      return outcome;
    }
    log.info(outcome.message ?? "Concluído", { stats });
    await log.flush();
    await finish(outcome.status, { stats });
    await db.updateTable("app.connected_accounts").set({
      status: "connected", last_sync_at: new Date(), last_error: outcome.status === "partial" ? (outcome.message ?? "Sincronização parcial") : null,
      ...(outcome.status === "succeeded" ? { last_successful_sync_at: new Date() } : {}),
    }).where("id", "=", account.id).execute();
    return { ...outcome, stats };
  } catch (error) {
    const err = error instanceof IntegrationError ? error : new IntegrationError((error as Error).message ?? "Erro inesperado", "permanent");
    log.error(`Falha: ${err.message}`, { kind: err.kind, status: err.status, providerCode: err.providerCode });
    await log.flush();
    const accountStatus = err.kind === "auth" ? "expired" : "error";
    await db.updateTable("app.connected_accounts").set({
      status: accountStatus, last_error: err.message.slice(0, 500), last_error_at: new Date(), last_sync_at: new Date(),
    }).where("id", "=", account.id).execute();

    const retriable = err.kind === "transient" || err.kind === "rate_limit";
    if (retriable && job.attempts < job.max_attempts) {
      const delayMs = err.retryAfterMs ?? Math.min(60 * 60_000, 60_000 * 2 ** (job.attempts - 1));
      await db.updateTable("app.sync_jobs").set({
        status: "queued", run_after: new Date(Date.now() + delayMs), locked_until: null, error: err.message.slice(0, 1000),
      }).where("id", "=", job.id).execute();
      return { status: "retry", error: err.message };
    }
    await finish("failed", { error: err.message.slice(0, 1000) });
    return { status: "failed", error: err.message };
  }
}

/** Processa a fila até esgotar o orçamento de tempo (compatível com serverless). */
export async function processQueue(db: Database, options: RunOptions & { budgetMs: number; maxJobs?: number }) {
  const startedAt = Date.now();
  const results: Array<{ jobId: string; status: string }> = [];
  while (Date.now() - startedAt < options.budgetMs * 0.8 && results.length < (options.maxJobs ?? 20)) {
    const job = await claimNextJob(db);
    if (!job) break;
    const remaining = options.budgetMs - (Date.now() - startedAt);
    const outcome = await runJob(db, job, { ...options, jobBudgetMs: Math.max(5_000, Math.min(options.jobBudgetMs ?? 240_000, remaining - 5_000)) });
    results.push({ jobId: job.id, status: outcome.status });
  }
  return results;
}
