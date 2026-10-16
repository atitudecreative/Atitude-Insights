import { NextResponse, type NextRequest } from "next/server";
import { getActor } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { withUserDb } from "@/server/db";
import { renderReportPdf } from "@/server/reports/pdf";
import { ServiceError } from "@/server/services/context";
import { liveReport } from "@/server/services/reports";
import { getBranding } from "@/server/services/settings";
import { reportParamsFromSearch } from "@/lib/report-params";
import { slugify } from "@/lib/format";

export const runtime = "nodejs";

/** PDF do relatório instantâneo — mesmo controle de acesso (RLS) da visualização. */
export async function GET(req: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const params = reportParamsFromSearch((k) => sp.get(k) ?? undefined);
  try {
    const { data, financials } = await liveReport(actor, params);
    const title = (sp.get("titulo") ?? "").slice(0, 160) || `Relatório — ${data.subject.campaignName ?? data.subject.eventName ?? data.subject.ministryName ?? "Agência"}`;
    const pdf = await renderReportPdf({ data, financials, text: { title }, brand: await getBranding(), investmentRestricted: !financials });
    await withUserDb(actor.userId, (trx) => audit(trx, { ministryId: data.params.ministryId, entityType: "report", action: "exported_pdf", summary: `PDF exportado: ${title}`, changes: { params } }));
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${slugify(title) || "relatorio"}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: "Relatório não encontrado" }, { status: error.code === "invalid" ? 400 : 404 });
    }
    console.error("[report-pdf]", (error as Error).message);
    return NextResponse.json({ error: "Falha ao gerar o PDF" }, { status: 500 });
  }
}
