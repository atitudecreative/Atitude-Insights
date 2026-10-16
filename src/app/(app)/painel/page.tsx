import type { Metadata } from "next";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { parsePeriod } from "@/lib/period";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { getDashboard } from "@/server/services/analytics";
import { getDataMode } from "@/server/services/mode";
import { CHANNEL_FILTER, filterOptions } from "@/server/services/options";

export const metadata: Metadata = { title: "Painel" };

export default async function PainelPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const period = parsePeriod({ periodo: param(sp, "periodo"), inicio: param(sp, "inicio"), fim: param(sp, "fim") });
  const ministryId = param(sp, "ministerio");
  const [d, options] = await Promise.all([
    getDashboard(actor, { mode, start: period.start, end: period.end, ministryId, campaignId: param(sp, "campanha"), eventId: param(sp, "evento"), channel: param(sp, "canal") }),
    filterOptions(actor, mode, ministryId),
  ]);
  const linkQuery = ministryId ? `ministerio=${ministryId}` : "";
  const firstName = actor.name.split(" ")[0];
  return (
    <>
      <PageHeader
        title={isAgencyStaff(actor) ? "Painel da agência" : `Olá, ${firstName}`}
        description={isAgencyStaff(actor)
          ? "Visão executiva do trabalho realizado, das campanhas e dos resultados em todos os ministérios do seu escopo."
          : "Resumo do trabalho da agência para os ministérios aos quais você tem acesso."}
      />
      <FilterBar filters={[
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "campanha", label: "Campanha", allLabel: "Todas", options: options.campaigns.map((c) => ({ value: c.id, label: c.name })) },
        { name: "evento", label: "Evento", options: options.events.map((e) => ({ value: e.id, label: e.name })) },
        { name: "canal", label: "Canal", options: CHANNEL_FILTER },
      ]} />
      <DashboardView d={d} linkQuery={linkQuery} periodLabel={period.label} />
    </>
  );
}
