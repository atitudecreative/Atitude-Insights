import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { runSchedulerTick } from "@/server/integrations/runtime";
import { safeEqual } from "@/server/security/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Agendador de sincronizações. Chamado pelo Vercel Cron (ou qualquer cron
 * externo) com `Authorization: Bearer $CRON_SECRET`. Idempotente: jobs
 * ativos não são duplicados e jobs longos continuam na próxima execução.
 */
async function handle(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }
  const result = await runSchedulerTick(50_000);
  return NextResponse.json({ ok: true, enqueued: result.enqueued, processed: result.processed.length, jobs: result.processed });
}

export const GET = handle;
export const POST = handle;
