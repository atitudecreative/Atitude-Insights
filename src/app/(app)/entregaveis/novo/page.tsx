import type { Metadata } from "next";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { getDataMode } from "@/server/services/mode";
import { operationsFormOptions } from "@/server/services/tasks";
import { saveDeliverableAction } from "../actions";
import { DeliverableForm } from "../deliverable-form";

export const metadata: Metadata = { title: "Novo entregável" };

export default async function NewDeliverablePage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const options = await operationsFormOptions(actor, await getDataMode(), { tasks: true });
  // Ministério inferido da campanha ou do evento informados na URL.
  const campaign = options.campaigns.find((c) => c.id === param(sp, "campanha"));
  const event = options.events.find((e) => e.id === param(sp, "evento") && (!campaign || e.ministry_id === campaign.ministry_id));
  const presetMinistry = campaign?.ministry_id ?? event?.ministry_id ?? (options.ministries.some((m) => m.id === param(sp, "ministerio")) ? param(sp, "ministerio") : undefined);
  const back = campaign ? { label: campaign.name, href: `/campanhas/${campaign.id}` } : event ? { label: event.name, href: `/eventos/${event.id}` } : null;
  return (
    <>
      <PageHeader title="Novo entregável" breadcrumbs={[{ label: "Entregáveis", href: "/entregaveis" }, ...(back ? [back] : []), { label: "Novo" }]}
        description="Registre peças e materiais produzidos pela agência: artes, vídeos, landing pages, e-mails e outros." />
      {options.ministries.length ? (
        <DeliverableForm action={saveDeliverableAction.bind(null, null)} options={options}
          defaults={{ ministryId: presetMinistry ?? (options.ministries.length === 1 ? options.ministries[0]!.id : undefined), campaignId: campaign?.id, eventId: event?.id }} />
      ) : (
        <EmptyState icon={Package} title="Você não pode registrar entregáveis" description="É necessário perfil de gestão da agência em pelo menos um ministério." />
      )}
    </>
  );
}
