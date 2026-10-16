import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, ExternalLink, Info, ListChecks, Megaphone, Newspaper } from "lucide-react";
import type { ReactNode } from "react";
import { ScopedSelects } from "@/components/ops/scoped-selects";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/format";
import { requireActor } from "@/server/auth/current";
import { hasGlobalManage } from "@/server/auth/types";
import { listUnclassified } from "@/server/services/classification";
import { getDataMode } from "@/server/services/mode";
import { operationsFormOptions } from "@/server/services/tasks";
import { classifyItemAction } from "./actions";

export const metadata: Metadata = { title: "Itens não classificados" };

type Options = Awaited<ReturnType<typeof operationsFormOptions>>;

function ItemRow({ title, meta, reason, href, form }: { title: string; meta: ReactNode; reason: string | null; href?: string | null; form: ReactNode }) {
  return (
    <li className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-subtle">{meta}</p>
        <p className="mt-1.5 text-xs text-muted"><span className="font-medium">Motivo:</span> {reason ?? "Nenhuma regra de mapeamento correspondeu"}</p>
        {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">Abrir na origem <ExternalLink className="size-3" aria-hidden /></a> : null}
      </div>
      <div className="min-w-0">{form}</div>
    </li>
  );
}

function ClassifyForm({ entity, id, options, withEvent }: { entity: "task" | "external_campaign" | "social_post"; id: string; options: Options; withEvent?: boolean }) {
  return (
    <ActionForm action={classifyItemAction.bind(null, entity, id)} submitLabel="Classificar" resetOnSuccess={false}>
      <ScopedSelects idPrefix={`${entity}-${id}`} ministries={options.ministries} campaigns={options.campaigns} events={withEvent ? options.events : undefined}
        className={withEvent ? "sm:grid-cols-3 md:grid-cols-3" : "sm:grid-cols-2"} />
    </ActionForm>
  );
}

export default async function ClassificationPage() {
  const actor = await requireActor();
  if (!hasGlobalManage(actor)) notFound();
  const [items, options] = await Promise.all([listUnclassified(actor), operationsFormOptions(actor, await getDataMode())]);
  const total = items.tasks.length + items.campaigns.length + items.posts.length;
  return (
    <>
      <PageHeader title="Itens não classificados" description="Itens sincronizados que nenhuma regra conseguiu associar a um ministério. Enquanto não classificados, não aparecem para os ministérios." />
      <div role="note" className="mb-6 flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-4 py-3 text-sm text-info">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>A classificação manual é <strong>preservada pelas próximas sincronizações</strong>: o item passa a ser “manual” e as regras automáticas não o sobrescrevem. Cada decisão fica registrada no histórico de auditoria.</span>
      </div>
      {total === 0 ? (
        <EmptyState icon={CheckCircle2} title="Tudo classificado" description="Não há demandas, campanhas da Meta ou publicações aguardando classificação." />
      ) : null}
      <div className="space-y-4">
        <Card>
          <CardHeader title="Demandas do Asana" description="Defina o ministério e, se quiser, a campanha e o evento" action={<Badge tone={items.tasks.length ? "warning" : "neutral"}>{items.tasks.length}</Badge>} />
          <CardContent>
            {items.tasks.length ? (
              <ul className="divide-y divide-border">
                {items.tasks.map((t) => (
                  <ItemRow key={t.id} title={t.name} reason={t.classification_reason} href={t.permalink_url}
                    meta={<>{t.section_name ? `Seção ${t.section_name} · ` : ""}{t.created_at_source ? `criada ${formatDate(t.created_at_source)}` : "data desconhecida"}{t.completed ? " · concluída" : ""}</>}
                    form={<ClassifyForm entity="task" id={t.id} options={options} withEvent />} />
                ))}
              </ul>
            ) : <EmptyState compact icon={ListChecks} title="Nenhuma demanda pendente" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Campanhas da Meta" description="Campanhas publicitárias sem ministério; opcionalmente vincule a uma campanha de comunicação" action={<Badge tone={items.campaigns.length ? "warning" : "neutral"}>{items.campaigns.length}</Badge>} />
          <CardContent>
            {items.campaigns.length ? (
              <ul className="divide-y divide-border">
                {items.campaigns.map((c) => (
                  <ItemRow key={c.id} title={c.name} reason={c.classification_reason}
                    meta={<>{c.account_name} · {c.effective_status ?? "status desconhecido"}{c.start_time ? ` · início ${formatDate(c.start_time)}` : ""}</>}
                    form={<ClassifyForm entity="external_campaign" id={c.id} options={options} />} />
                ))}
              </ul>
            ) : <EmptyState compact icon={Megaphone} title="Nenhuma campanha da Meta pendente" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Publicações" description="Publicações orgânicas do Instagram e do Facebook" action={<Badge tone={items.posts.length ? "warning" : "neutral"}>{items.posts.length}</Badge>} />
          <CardContent>
            {items.posts.length ? (
              <ul className="divide-y divide-border">
                {items.posts.map((p) => (
                  <ItemRow key={p.id} title={p.caption || "(sem legenda)"} reason={p.classification_reason} href={p.permalink}
                    meta={<>{p.platform === "instagram" ? "Instagram" : "Facebook"} · {p.account_name} · {formatDate(p.published_at)}</>}
                    form={<ClassifyForm entity="social_post" id={p.id} options={options} />} />
                ))}
              </ul>
            ) : <EmptyState compact icon={Newspaper} title="Nenhuma publicação pendente" />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
