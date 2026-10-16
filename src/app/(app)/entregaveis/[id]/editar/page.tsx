import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { requireActor } from "@/server/auth/current";
import { getDeliverable } from "@/server/services/deliverables";
import { operationsFormOptions } from "@/server/services/tasks";
import { saveDeliverableAction } from "../../actions";
import { DeliverableForm } from "../../deliverable-form";

export const metadata: Metadata = { title: "Editar entregável" };

export default async function EditDeliverablePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getDeliverable(actor, id);
  if (!data || !data.access.canManage) notFound();
  const d = data.deliverable;
  const options = await operationsFormOptions(actor, d.is_demo ? "demo" : "production", { tasks: true });
  return (
    <>
      <PageHeader title={`Editar: ${d.title}`} breadcrumbs={[{ label: "Entregáveis", href: "/entregaveis" }, { label: d.title, href: `/entregaveis/${id}` }, { label: "Editar" }]} />
      <DeliverableForm isEdit action={saveDeliverableAction.bind(null, id)} options={{ ...options, ministries: [{ id: d.ministry_id, name: d.ministry_name }] }}
        defaults={{
          ministryId: d.ministry_id, campaignId: d.campaign_id, eventId: d.event_id, taskId: d.task_id, title: d.title, description: d.description,
          type: d.type, status: d.status, url: d.url, dueDate: d.due_date,
        }} />
    </>
  );
}
