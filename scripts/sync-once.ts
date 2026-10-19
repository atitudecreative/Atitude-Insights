/**
 * Executa UM ciclo do agendador e encerra (para Cron Jobs do Render ou
 * qualquer agendador que rode comandos). Uso: npm run sync:once
 */
import { closeSystemDb } from "../src/server/db";
import { runSchedulerTick } from "../src/server/integrations/runtime";

const budgetMs = Number(process.env.SYNC_BUDGET_MS ?? 240_000);

runSchedulerTick(budgetMs)
  .then((r) => console.log(`[sync] enfileirados=${r.enqueued} processados=${r.processed.length}`, JSON.stringify(r.processed)))
  .catch((e: unknown) => {
    console.error("[sync] falha:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeSystemDb());
