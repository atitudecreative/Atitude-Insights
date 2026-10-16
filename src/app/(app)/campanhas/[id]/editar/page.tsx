import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { requireActor } from "@/server/auth/current";
import { campaignFormOptions, getCampaign } from "@/server/services/campaigns";
import { saveCampaignAction } from "../../actions";
import { CampaignForm } from "../../campaign-form";

export const metadata: Metadata = { title: "Editar campanha" };

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getCampaign(actor, id);
  if (!data || !data.access.canManage) notFound();
  const options = await campaignFormOptions(actor, data.campaign.is_demo ? "demo" : "production");
  const c = data.campaign;
  return (
    <>
      <PageHeader title={`Editar: ${c.name}`} breadcrumbs={[{ label: "Campanhas", href: "/campanhas" }, { label: c.name, href: `/campanhas/${id}` }, { label: "Editar" }]} />
      <CampaignForm isEdit action={saveCampaignAction.bind(null, id)} options={{ ...options, ministries: [{ id: c.ministry_id, name: c.ministry_name }] }}
        defaults={{
          ministryId: c.ministry_id, name: c.name, description: c.description, objective: c.objective, targetAudience: c.target_audience,
          startDate: c.start_date, endDate: c.end_date, status: c.status, channelIds: data.channels.map((x) => x.id),
          responsibleIds: data.responsibles.map((x) => x.id), eventIds: data.events.map((x) => x.id),
        }} />
    </>
  );
}
