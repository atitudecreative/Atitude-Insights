import { NextResponse } from "next/server";
import { sql, systemDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Verificação de saúde (sem dados sensíveis). */
export async function GET() {
  try {
    await sql`select 1`.execute(systemDb());
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
