import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireActor } from "@/server/auth/current";
import { listMinistries } from "@/server/services/ministries";
import { getDataMode } from "@/server/services/mode";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Ministérios" };

export default async function MinistriesPage() {
  const actor = await requireActor();
  const mode = await getDataMode();
  const ministries = await listMinistries(actor, { mode });
  return (
    <>
      <PageHeader title="Ministérios" description="Ministérios e departamentos aos quais você tem acesso."
        actions={actor.globalRole === "superadmin" ? <Button asChild variant="secondary"><Link href="/admin/ministerios">Gerenciar ministérios</Link></Button> : null} />
      {ministries.length === 0 ? (
        <EmptyState icon={Building2} title="Nenhum ministério disponível"
          description={actor.globalRole === "superadmin" ? "Cadastre o primeiro ministério na área administrativa." : "Você ainda não foi vinculado a nenhum ministério. Fale com o administrador."} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ministries.map((m) => (
            <li key={m.id}>
              <Link href={`/ministerios/${m.slug}`} className="group flex h-full items-start gap-4 rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:border-border-strong">
                <span aria-hidden className="mt-0.5 size-10 shrink-0 rounded-xl" style={{ background: m.color ?? "var(--brand)", opacity: 0.9 }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{m.name}</span>
                    {m.is_demo ? <Badge tone="warning">Demo</Badge> : null}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-sm text-subtle">{m.description ?? "Sem descrição"}</span>
                </span>
                <ChevronRight className="mt-2 size-4 shrink-0 text-subtle group-hover:text-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
