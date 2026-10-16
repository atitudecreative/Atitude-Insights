import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, CheckCircle2, ExternalLink, MessageSquare, Pencil } from "lucide-react";
import { IntentForm } from "@/components/ops/intent-form";
import { ActionForm } from "@/components/ui/action-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime } from "@/lib/format";
import { DELIVERABLE_STATUS, DELIVERABLE_TYPE } from "@/lib/labels";
import { requireActor } from "@/server/auth/current";
import { getDeliverable } from "@/server/services/deliverables";
import { commentDeliverableAction, reviewDeliverableAction } from "../actions";

export const metadata: Metadata = { title: "Entregável" };

export default async function DeliverablePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const data = await getDeliverable(actor, id);
  if (!data) notFound();
  const { deliverable: d, access, comments } = data;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Entregáveis", href: "/entregaveis" }, ...(d.campaign_id && d.campaign_name ? [{ label: d.campaign_name, href: `/campanhas/${d.campaign_id}` }] : []), { label: d.title }]}
        eyebrow={<span className="flex items-center gap-2"><Badge tone="neutral">{DELIVERABLE_TYPE[d.type] ?? d.type}</Badge><StatusBadge map={DELIVERABLE_STATUS} value={d.status} />{d.is_demo ? <Badge tone="warning">Demonstração</Badge> : null}</span>}
        title={d.title}
        description={<span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{d.delivered_at ? `Entregue em ${formatDate(d.delivered_at)}` : d.due_date ? `Prazo ${formatDate(d.due_date)}` : "Sem prazo"} · {d.ministry_name}</span>}
        actions={<>
          {d.url ? <Button asChild variant="secondary"><a href={d.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> Abrir entregável</a></Button> : null}
          {access.canManage ? <Button asChild variant="secondary"><Link href={`/entregaveis/${id}/editar`}><Pencil /> Editar</Link></Button> : null}
        </>}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Detalhes" />
            <CardContent className="space-y-4 text-sm">
              {d.description ? <p className="whitespace-pre-line text-muted">{d.description}</p> : <p className="text-subtle">Sem descrição.</p>}
              <dl className="grid gap-4 sm:grid-cols-2">
                <div><dt className="text-xs font-medium text-subtle">Link</dt><dd className="mt-1 min-w-0 break-all">{d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{d.url}</a> : "—"}</dd></div>
                <div><dt className="text-xs font-medium text-subtle">Campanha</dt><dd className="mt-1">{d.campaign_id ? <Link href={`/campanhas/${d.campaign_id}`} className="text-brand hover:underline">{d.campaign_name}</Link> : "—"}</dd></div>
                <div><dt className="text-xs font-medium text-subtle">Evento</dt><dd className="mt-1">{d.event_id ? <Link href={`/eventos/${d.event_id}`} className="text-brand hover:underline">{d.event_name}</Link> : "—"}</dd></div>
                <div><dt className="text-xs font-medium text-subtle">Demanda</dt><dd className="mt-1">{d.task_id ? (d.task_url
                  ? <a href={d.task_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">{d.task_name}<ExternalLink className="size-3.5" aria-hidden /></a>
                  : d.task_name) : "—"}</dd></div>
                <div><dt className="text-xs font-medium text-subtle">Registrado em</dt><dd className="mt-1">{formatDateTime(d.created_at)}</dd></div>
                <div><dt className="text-xs font-medium text-subtle">Aprovação</dt><dd className="mt-1">{d.approved_at ? `Aprovado por ${d.approved_by_name ?? "—"} em ${formatDateTime(d.approved_at)}` : "Não aprovado"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Comentários" description="Conversa entre a agência e o ministério sobre este entregável" />
            <CardContent>
              {comments.length ? (
                <ol className="space-y-3">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-lg bg-surface-muted px-3 py-2.5">
                      <p className="text-xs text-subtle"><span className="font-medium text-muted">{c.author ?? "Usuário removido"}</span> · {formatDateTime(c.created_at)}</p>
                      <p className="mt-1 whitespace-pre-line text-sm">{c.body}</p>
                    </li>
                  ))}
                </ol>
              ) : <EmptyState compact icon={MessageSquare} title="Nenhum comentário ainda" />}
              {access.canCollaborate ? (
                <div className="mt-4 border-t border-border pt-4">
                  <ActionForm action={commentDeliverableAction.bind(null, id)} submitLabel="Comentar" submitVariant="secondary">
                    <Field label="Novo comentário" htmlFor="c-body"><Textarea id="c-body" name="body" required maxLength={4000} rows={3} /></Field>
                  </ActionForm>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          {access.canCollaborate ? (
            <Card>
              <CardHeader title="Aprovação" description="Aprove o entregável ou solicite ajustes com um comentário" />
              <CardContent>
                {d.status === "approved" ? (
                  <p className="mb-3 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success"><CheckCircle2 className="size-4" aria-hidden /> Aprovado {d.approved_at ? formatDate(d.approved_at) : ""}</p>
                ) : null}
                <IntentForm action={reviewDeliverableAction.bind(null, id)} buttons={[
                  { intent: "changes_requested", label: "Solicitar ajustes", variant: "outline" },
                  { intent: "approved", label: "Aprovar" },
                ]}>
                  <Field label="Comentário" htmlFor="r-comment" hint="Obrigatório para solicitar ajustes."><Textarea id="r-comment" name="comment" maxLength={4000} rows={4} /></Field>
                </IntentForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Situação" />
            <CardContent className="space-y-2 text-sm">
              <p className="flex items-center justify-between gap-2"><span className="text-subtle">Status</span><StatusBadge map={DELIVERABLE_STATUS} value={d.status} /></p>
              <p className="flex items-center justify-between gap-2"><span className="text-subtle">Prazo</span><span className="tabular">{formatDate(d.due_date)}</span></p>
              <p className="flex items-center justify-between gap-2"><span className="text-subtle">Entrega</span><span className="tabular">{formatDate(d.delivered_at)}</span></p>
              <p className="flex items-center justify-between gap-2"><span className="text-subtle">Ministério</span><span>{d.ministry_name}</span></p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
