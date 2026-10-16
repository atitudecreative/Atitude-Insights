import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/current";
import { isAgencyStaff } from "@/server/auth/types";
import { listMinistries } from "@/server/services/ministries";

export default async function Home() {
  const actor = await requireActor();
  if (!isAgencyStaff(actor)) {
    const ministries = await listMinistries(actor, { mode: "production" });
    if (ministries.length === 1) redirect(`/ministerios/${ministries[0]!.slug}`);
  }
  redirect("/painel");
}
