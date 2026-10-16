import { NextResponse, type NextRequest } from "next/server";
import { todayIso } from "@/lib/period";
import { getActor } from "@/server/auth/current";
import { buildCsv, csvResponse, logExport, type CsvCell } from "@/server/services/export";
import { getDataMode } from "@/server/services/mode";
import { listTasks, taskFiltersFromParams } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;
const PAGE = 500;
const STATUS = { completed: "Concluída", overdue: "Atrasada", open: "Em andamento" } as const;

/** Exporta as demandas visíveis ao usuário (RLS) com os mesmos filtros da tela. */
export async function GET(request: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const sp = request.nextUrl.searchParams;
  const get = (k: string) => {
    const v = sp.get(k);
    return v && v.length <= 200 ? v : undefined;
  };
  const filters = taskFiltersFromParams(get, await getDataMode());
  const today = todayIso();
  const rows: CsvCell[][] = [];
  for (let page = 1; rows.length < MAX_ROWS; page++) {
    const res = await listTasks(actor, { ...filters, page, pageSize: PAGE });
    for (const t of res.rows) {
      if (rows.length >= MAX_ROWS) break;
      const status = t.completed ? "completed" : t.due_on && t.due_on < today ? "overdue" : "open";
      rows.push([t.name, STATUS[status], t.source === "asana" ? "Asana" : "Manual", t.ministry_name, t.campaign_name, t.event_name,
        t.assignee_name, t.section_name, t.due_on, t.completed_at, t.permalink_url]);
    }
    if (res.rows.length < PAGE || page * PAGE >= res.total) break;
  }
  const csv = buildCsv(["Demanda", "Status", "Origem", "Ministério", "Campanha", "Evento", "Responsável", "Seção", "Prazo", "Concluída em", "Link"], rows);
  await logExport(actor, "tasks", { ...filters, mode: filters.mode }, rows.length);
  return csvResponse(csv, `demandas-${today}.csv`);
}
