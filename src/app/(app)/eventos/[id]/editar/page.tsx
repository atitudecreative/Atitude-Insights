import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { requireActor } from "@/server/auth/current";
import { getEvent } from "@/server/services/events";
import { operationsFormOptions } from "@/server/services/tasks";
import { saveEventAction } from "../../actions";
import { EventForm } from "../../event-form";
import { toLocalInput } from "../../utils";

export const metadata: Metadata = { title: "Editar evento" };

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getEvent(actor, id);
  if (!data || !data.access.canManage) notFound();
  const e = data.event;
  const options = await operationsFormOptions(actor, e.is_demo ? "demo" : "production", { users: true });
  return (
    <>
      <PageHeader title={`Editar: ${e.name}`} breadcrumbs={[{ label: "Eventos", href: "/eventos" }, { label: e.name, href: `/eventos/${id}` }, { label: "Editar" }]} />
      <EventForm isEdit action={saveEventAction.bind(null, id)} options={{ ...options, ministries: [{ id: e.ministry_id, name: e.ministry_name }] }}
        defaults={{
          ministryId: e.ministry_id, name: e.name, description: e.description, startsAt: toLocalInput(e.starts_at), endsAt: toLocalInput(e.ends_at),
          location: e.location, communicationObjective: e.communication_objective, promotionStart: e.promotion_start, promotionEnd: e.promotion_end,
          status: e.status, links: e.links, responsibleIds: data.responsibles.map((r) => r.id), campaignIds: data.campaigns.map((c) => c.id),
        }} />
    </>
  );
}
