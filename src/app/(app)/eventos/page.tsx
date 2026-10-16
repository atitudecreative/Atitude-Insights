import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, MapPin, Megaphone, Package, Plus } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { formatDate, formatEventDate } from "@/lib/format";
import { EVENT_STATUS } from "@/lib/labels";
import { flatParams, pageParam, param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { listEvents } from "@/server/services/events";
import { getDataMode } from "@/server/services/mode";
import { filterOptions } from "@/server/services/options";

export const metadata: Metadata = { title: "Eventos" };

const WHEN = { proximos: "upcoming", passados: "past", todos: "all" } as const;
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", timeZone: "America/Sao_Paulo" });
const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "America/Sao_Paulo" });

export default async function EventsPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const mode = await getDataMode();
  const ministryId = param(sp, "ministerio");
  const quando = param(sp, "quando");
  const when = WHEN[(quando ?? "proximos") as keyof typeof WHEN] ?? "upcoming";
  const [data, options] = await Promise.all([
    listEvents(actor, { mode, ministryId, status: param(sp, "status"), when, q: param(sp, "q"), page: pageParam(sp), pageSize: 18 }),
    filterOptions(actor, mode, ministryId),
  ]);
  const now = new Date();
  return (
    <>
      <PageHeader title="Eventos" description="Eventos dos ministérios e a comunicação de cada um: divulgação, demandas, entregáveis e resultados."
        actions={isAgencyStaff(actor) ? <Button asChild><Link href="/eventos/novo"><Plus /> Novo evento</Link></Button> : null} />
      <FilterBar period={false} search={{ name: "q", placeholder: "Nome do evento" }} filters={[
        { name: "quando", label: "Quando", allLabel: "Próximos e em andamento", options: [{ value: "passados", label: "Já iniciados" }, { value: "todos", label: "Todos" }] },
        { name: "ministerio", label: "Ministério", options: options.ministries.map((m) => ({ value: m.id, label: m.name })) },
        { name: "status", label: "Status", options: Object.entries(EVENT_STATUS).map(([value, v]) => ({ value, label: v.label })) },
      ]} />
      {data.rows.length ? (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Eventos">
          {data.rows.map((e) => {
            const start = new Date(e.starts_at);
            const end = e.ends_at ? new Date(e.ends_at) : null;
            const happening = start <= now && (end ?? new Date(start.getTime() + 4 * 3600_000)) >= now;
            return (
              <li key={e.id}>
                <Card className="h-full transition-colors hover:border-border-strong">
                  <Link href={`/eventos/${e.id}`} className="flex h-full gap-4 p-4 focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex w-14 shrink-0 flex-col items-center self-start rounded-lg border border-border bg-surface-muted py-1.5 text-center">
                      <span className="text-[10px] font-medium uppercase text-subtle">{monthFmt.format(start).replace(".", "")}</span>
                      <span className="tabular text-xl font-semibold leading-6">{dayFmt.format(start)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge map={EVENT_STATUS} value={e.status} />
                        {happening ? <Badge tone="success">Acontecendo agora</Badge> : null}
                      </span>
                      <span className="mt-1.5 block font-medium text-foreground">{e.name}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-subtle">
                        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: e.ministry_color ?? "var(--brand)" }} />{e.ministry_name}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-subtle"><CalendarDays className="size-3.5 shrink-0" aria-hidden />{formatEventDate(e.starts_at)}</span>
                      {e.location ? <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-subtle"><MapPin className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{e.location}</span></span> : null}
                      <span className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        <span className="inline-flex items-center gap-1"><Megaphone className="size-3.5" aria-hidden />{e.campaigns} {e.campaigns === 1 ? "campanha" : "campanhas"}</span>
                        <span className="inline-flex items-center gap-1"><Package className="size-3.5" aria-hidden />{e.deliverables} {e.deliverables === 1 ? "entregável" : "entregáveis"}</span>
                        {e.promotion_start ? <span>Divulgação desde {formatDate(e.promotion_start)}</span> : null}
                      </span>
                    </span>
                  </Link>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={CalendarDays} title="Nenhum evento encontrado"
          description={when === "upcoming" ? "Não há eventos futuros para os filtros. Veja também os eventos já iniciados." : "Ajuste os filtros ou cadastre um novo evento."} />
      )}
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/eventos" params={flatParams(sp)} />
    </>
  );
}
