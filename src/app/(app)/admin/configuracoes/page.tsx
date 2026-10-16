import type { Metadata } from "next";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { ActionButton } from "@/components/admin/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireSuperadmin } from "@/server/auth/current";
import { env } from "@/server/env";
import { demoStatus } from "@/server/services/demo";
import { getBranding } from "@/server/services/settings";
import { loadDemoAction, removeDemoAction, saveBrandingAction } from "../actions";
import { BrandingForm } from "./branding-form";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage() {
  const actor = await requireSuperadmin();
  const [brand, demo] = await Promise.all([getBranding(), demoStatus(actor)]);
  const e = env();
  const retention = [
    { label: "Sessões", value: `Expiram após ${e.SESSION_IDLE_HOURS} h de inatividade e, no máximo, ${e.SESSION_ABSOLUTE_DAYS} dias após o login. Desativar um usuário encerra todas as sessões.` },
    { label: "Convites e links de senha", value: "Uso único; convites expiram em 72 h e links de redefinição em 24 h. Somente o hash do token é armazenado." },
    { label: "Histórico de métricas", value: "Observações diárias e snapshots são mantidos para comparações entre períodos; sincronizações repetidas atualizam, nunca duplicam." },
    { label: "Auditoria", value: "Registros de auditoria são somente inclusão e preservados mesmo após a exclusão lógica de usuários." },
    { label: "Credenciais de integração", value: "Cifradas com AES-256-GCM (ENCRYPTION_KEY) e apagadas ao desconectar a conta. Nunca são exibidas no portal." },
    { label: "Usuários excluídos", value: "Exclusão lógica: dados pessoais permanecem apenas no histórico de auditoria; o e-mail pode ser reutilizado em um novo convite." },
  ];
  return (
    <>
      <PageHeader title="Configurações" description="Identidade visual do portal, retenção de dados e dados de demonstração."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Configurações" }]} />
      <div className="space-y-4">
        <Card>
          <CardHeader title="Identidade visual" description="Aplicada a todo o portal e aos relatórios." />
          <CardContent><BrandingForm action={saveBrandingAction} defaults={brand} /></CardContent>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Retenção e proteção de dados" action={<ShieldCheck className="size-4 text-subtle" aria-hidden />} />
            <CardContent>
              <dl className="space-y-3 text-sm">
                {retention.map((r) => <div key={r.label}><dt className="font-medium">{r.label}</dt><dd className="text-muted">{r.value}</dd></div>)}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Dados de demonstração" action={demo.loaded ? <Badge tone="warning">Carregados · {demo.ministries} ministérios</Badge> : <Badge tone="muted">Não carregados</Badge>} />
            <CardContent className="space-y-4 text-sm">
              <p className="text-muted">
                Cria três ministérios fictícios (<span className="font-medium">[DEMO] Atitude Kids</span>, <span className="font-medium">[DEMO] Mulheres</span> e <span className="font-medium">[DEMO] Frontline</span>)
                com campanhas, eventos, demandas, entregáveis, investimentos, metas e 90 dias de métricas da Meta.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-subtle">
                <li>Os dados ficam marcados como demonstração e <strong>nunca</strong> aparecem no modo produção, nos relatórios reais ou nas contagens de não classificados.</li>
                <li>Uma conta conectada fictícia (“[DEMO] Conta fictícia”) é criada sem credenciais e não sincroniza.</li>
                <li>Carregar novamente substitui os dados de demonstração existentes (sem duplicar).</li>
                <li>Para visualizar, use “Modo demonstração” no menu lateral.</li>
              </ul>
              <div className="flex flex-wrap gap-2">
                <ActionButton action={loadDemoAction} label={<><FlaskConical /> {demo.loaded ? "Recarregar dados de demonstração" : "Carregar dados de demonstração"}</>}
                  pendingLabel="Carregando…" variant="primary" size="md"
                  confirm={demo.loaded ? "Substituir os dados de demonstração atuais por um novo conjunto?" : "Carregar dados fictícios de demonstração?"} />
                {demo.loaded ? (
                  <ActionButton action={removeDemoAction} label="Remover dados de demonstração" pendingLabel="Removendo…" variant="danger-ghost" size="md"
                    confirm="Remover todos os ministérios de demonstração e seus dados?" />
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
