import { NextResponse, type NextRequest } from "next/server";
import { getActor } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { withUserDb } from "@/server/db";
import { renderReportPdf } from "@/server/reports/pdf";
import { buildReport, getReport, getReportVersion, reportParamsFromRow } from "@/server/services/reports";
import { getBranding } from "@/server/services/settings";
import { slugify } from "@/lib/format";

export const runtime = "nodejs";

/** PDF de relatório salvo: versão publicada (congelada) ou prévia de rascunho para quem gerencia. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const { id } = await params;
  const found = await getReport(actor, id);
  // RLS: relatórios de outros ministérios (ou rascunhos sem permissão) retornam null.
  if (!found) return NextResponse.json({ error: "Relatório não encontrado" }, { status: 404 });
  const { report } = found;
  const text = { title: report.title, objectives: report.objectives, executiveSummary: report.executive_summary, learnings: report.learnings, observations: report.observations };
  const versionParam = req.nextUrl.searchParams.get("versao") ?? undefined;
  let payload: { data: Awaited<ReturnType<typeof buildReport>>["data"]; financials: Awaited<ReturnType<typeof buildReport>>["financials"] };
  if (report.status === "published" && versionParam !== "rascunho") {
    const v = await getReportVersion(actor, id, versionParam);
    if (!v) return NextResponse.json({ error: "Versão não encontrada" }, { status: 404 });
    payload = { data: v.data, financials: v.financials };
  } else {
    if (!found.access.canManage) return NextResponse.json({ error: "Relatório não encontrado" }, { status: 404 });
    payload = await withUserDb(actor.userId, (trx) => buildReport(trx, reportParamsFromRow(report)));
  }
  const pdf = await renderReportPdf({ ...payload, text, brand: await getBranding(), investmentRestricted: !payload.financials });
  await withUserDb(actor.userId, (trx) => audit(trx, { ministryId: report.ministry_id, entityType: "report", entityId: id, action: "exported_pdf", summary: `PDF exportado: ${report.title}` }));
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${slugify(report.title) || "relatorio"}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
