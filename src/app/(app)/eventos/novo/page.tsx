import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { getDataMode } from "@/server/services/mode";
import { operationsFormOptions } from "@/server/services/tasks";
import { saveEventAction } from "../actions";
import { EventForm } from "../event-form";

export const metadata: Metadata = { title: "Novo evento" };

export default async function NewEventPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const options = await operationsFormOptions(actor, await getDataMode(), { users: true });
  const preset = param(sp, "ministerio");
  return (
    <>
      <PageHeader title="Novo evento" breadcrumbs={[{ label: "Eventos", href: "/eventos" }, { label: "Novo" }]}
        description="Cadastre o evento e o planejamento de comunicação: divulgação, links, responsáveis e campanhas relacionadas." />
      {options.ministries.length ? (
        <EventForm action={saveEventAction.bind(null, null)} options={options}
          defaults={{ ministryId: options.ministries.some((m) => m.id === preset) ? preset : options.ministries.length === 1 ? options.ministries[0]!.id : undefined }} />
      ) : (
        <EmptyState icon={CalendarDays} title="Você não pode cadastrar eventos" description="É necessário perfil de gestão da agência em pelo menos um ministério." />
      )}
    </>
  );
}
