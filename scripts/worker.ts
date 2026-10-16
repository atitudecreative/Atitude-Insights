/**
 * Worker de sincronização para hospedagem com processo contínuo (Docker,
 * VPS, Railway, Fly). Executa um ciclo do agendador a cada minuto.
 * Uso: npm run worker
 */
import { runSchedulerTick } from "../src/server/integrations/runtime";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);
let stopping = false;

async function loop() {
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await runSchedulerTick(Math.max(30_000, INTERVAL_MS * 4));
      if (r.enqueued || r.processed.length) console.log(`[worker] ${new Date().toISOString()} enfileirados=${r.enqueued} processados=${r.processed.length}`);
    } catch (error) {
      console.error("[worker] erro no ciclo:", (error as Error).message);
    }
    const wait = Math.max(1000, INTERVAL_MS - (Date.now() - started));
    await new Promise((res) => setTimeout(res, wait));
  }
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });
void loop();
