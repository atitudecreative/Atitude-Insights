import type { Metadata } from "next";
import { Megaphone } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { param, type RawSearch } from "@/lib/search";
import { requireActor } from "@/server/auth/current";
import { campaignFormOptions } from "@/server/services/campaigns";
import { getDataMode } from "@/server/services/mode";
import { saveCampaignAction } from "../actions";
import { CampaignForm } from "../campaign-form";

export const metadata: Metadata = { title: "Nova campanha" };

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const options = await campaignFormOptions(actor, await getDataMode());
  const preset = param(sp, "ministerio");
  return (
    <>
      <PageHeader title="Nova campanha" breadcrumbs={[{ label: "Campanhas", href: "/campanhas" }, { label: "Nova" }]}
        description="Campanha de comunicação do portal — reúne demandas, entregáveis, publicações e campanhas publicitárias da Meta." />
      {options.ministries.length ? (
        <CampaignForm action={saveCampaignAction.bind(null, null)} options={options}
          defaults={{ ministryId: options.ministries.some((m) => m.id === preset) ? preset : options.ministries.length === 1 ? options.ministries[0]!.id : undefined }} />
      ) : (
        <EmptyState icon={Megaphone} title="Você não pode cadastrar campanhas" description="É necessário perfil de gestão da agência em pelo menos um ministério." />
      )}
    </>
  );
}
