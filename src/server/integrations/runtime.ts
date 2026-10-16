import "server-only";
import { systemDb } from "@/server/db";
import { env } from "@/server/env";
import type { KeyRing } from "./credentials";
import type { IntegrationConfig } from "./jobs";
import { processQueue } from "./jobs";
import { jobRegistry } from "./registry";
import { enqueueDueJobs } from "./scheduler";
import { runMaintenance } from "./maintenance";

export function keyRing(): KeyRing {
  return { current: env().ENCRYPTION_KEY, previous: env().ENCRYPTION_KEY_PREVIOUS || undefined };
}

export function integrationConfig(): IntegrationConfig {
  const e = env();
  return { metaAppId: e.META_APP_ID, metaAppSecret: e.META_APP_SECRET, asanaClientId: e.ASANA_CLIENT_ID, asanaClientSecret: e.ASANA_CLIENT_SECRET };
}

/** Um ciclo do agendador: enfileira jobs vencidos e processa a fila dentro do orçamento. */
export async function runSchedulerTick(budgetMs: number) {
  const db = systemDb();
  const enqueued = await enqueueDueJobs(db);
  const processed = await processQueue(db, {
    registry: jobRegistry, keys: keyRing(), config: integrationConfig(), graphVersion: env().META_GRAPH_VERSION, budgetMs,
  });
  await runMaintenance(db).catch((e: unknown) => console.error("[maintenance]", (e as Error).message));
  return { enqueued, processed };
}
