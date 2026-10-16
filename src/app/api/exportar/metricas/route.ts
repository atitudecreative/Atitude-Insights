import { NextResponse, type NextRequest } from "next/server";
import { parsePeriod } from "@/lib/period";
import { getActor } from "@/server/auth/current";
import { buildCsv, csvResponse, logExport, metricsExportRows } from "@/server/services/export";
import { getDataMode } from "@/server/services/mode";

export const dynamic = "force-dynamic";

const ENTITY = { meta_campaign: "Campanha da Meta", meta_ad_set: "Conjunto de anúncios", meta_ad: "Anúncio", social_post: "Publicação", external_asset: "Conta" } as const;

/** Métricas diárias de mídia paga visíveis ao usuário (RLS; monetárias só com permissão de investimento). */
export async function GET(request: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const sp = request.nextUrl.searchParams;
  const get = (k: string) => {
    const v = sp.get(k);
    return v && v.length <= 200 ? v : undefined;
  };
  const period = parsePeriod({ periodo: get("periodo"), inicio: get("inicio"), fim: get("fim") });
  const mode = await getDataMode();
  const ministryId = get("ministerio");
  const rows = await metricsExportRows(actor, { mode, start: period.start, end: period.end, ministryId });
  const csv = buildCsv(
    ["Data", "Ministério", "Fonte", "Métrica", "Tipo de entidade", "Entidade", "ID da entidade", "Valor", "Moeda", "Coletado em"],
    rows.map((r) => [r.period_start, r.ministry_name, r.source, r.metric_key, ENTITY[r.entity_type as keyof typeof ENTITY] ?? r.entity_type, r.entity_name,
      r.entity_id, Number(r.value), r.is_monetary ? r.currency : null, r.collected_at]),
  );
  await logExport(actor, "metrics", { mode, start: period.start, end: period.end, ministryId: ministryId ?? null }, rows.length);
  return csvResponse(csv, `metricas-${period.start}-a-${period.end}.csv`);
}
