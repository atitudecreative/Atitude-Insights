import { Info } from "lucide-react";
import type { Dashboard } from "@/server/services/analytics";
import {
  InvestmentByCampaign, MinistryPerformance, OperationalKpis, OperationsCharts, OrganicKpis, PaidKpis, RecentActivity, SectionTitle,
  SourcesStrip, SyncAlerts, TopPosts, TrendSection, UpcomingDeliveries, UpcomingEvents,
} from "./sections";

export function DashboardView({ d, linkQuery, showMinistryTable = true, periodLabel }: { d: Dashboard; linkQuery: string; showMinistryTable?: boolean; periodLabel: string }) {
  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SourcesStrip d={d} />
        <p className="text-xs text-subtle">Período: <span className="font-medium text-muted">{periodLabel}</span> · comparações com o período anterior de mesma duração</p>
      </div>
      {d.alerts ? <div className="mb-6"><SyncAlerts d={d} /></div> : null}

      <SectionTitle title="Operação" description="Demandas, entregáveis e campanhas" />
      <OperationalKpis d={d} linkQuery={linkQuery} />

      <div className="mt-4"><OperationsCharts d={d} /></div>

      <SectionTitle title="Mídia paga" description="Meta Ads — métricas fornecidas pela Meta e indicadores calculados pelo portal" />
      <PaidKpis d={d} />

      <SectionTitle title="Orgânico" description="Instagram e Facebook — sem somar alcance entre plataformas" />
      <OrganicKpis d={d} />

      <div className="mt-4"><TrendSection d={d} /></div>

      {showMinistryTable && d.byMinistry.length > 1 ? (
        <>
          <SectionTitle title="Ministérios" />
          <MinistryPerformance d={d} showSpend={d.investment.all} />
        </>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <InvestmentByCampaign d={d} />
          <TopPosts d={d} />
        </div>
        <div className="space-y-4">
          <UpcomingEvents d={d} />
          <UpcomingDeliveries d={d} />
          <RecentActivity d={d} />
        </div>
      </div>

      <p className="mt-8 flex items-start gap-2 text-xs text-subtle">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Os indicadores mostram resultados observados nas fontes conectadas. A coincidência de período entre entregas e resultados não implica relação de causa.
        “Indisponível” indica que a fonte não fornece o dado; “Sem integração”, que nenhuma conta está conectada.
      </p>
    </div>
  );
}
