import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/layout/brand-mark";
import { LogoutButton, MobileNav, Sidebar, type NavGroup } from "@/components/layout/nav";
import { requireActor } from "@/server/auth/current";
import { GLOBAL_ROLE_LABEL, hasGlobalManage, hasGlobalRead, isAgencyStaff } from "@/server/auth/types";
import { countUnclassified } from "@/server/services/classification";
import { getDataMode } from "@/server/services/mode";
import { getBranding } from "@/server/services/settings";
import { logoutAction } from "../(auth)/actions";
import { setModeAction } from "./mode-actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();
  const [brand, mode] = await Promise.all([getBranding(), getDataMode()]);
  const unclassified = hasGlobalManage(actor) ? await countUnclassified(actor) : 0;

  const groups: NavGroup[] = [
    {
      items: [
        { href: "/painel", label: isAgencyStaff(actor) ? "Painel da agência" : "Visão geral", icon: "dashboard" },
        { href: "/ministerios", label: "Ministérios", icon: "ministries" },
        { href: "/campanhas", label: "Campanhas", icon: "campaigns" },
        { href: "/eventos", label: "Eventos", icon: "events" },
        { href: "/demandas", label: "Demandas", icon: "tasks" },
        { href: "/entregaveis", label: "Entregáveis", icon: "deliverables" },
        { href: "/resultados", label: "Resultados", icon: "results" },
        { href: "/relatorios", label: "Relatórios", icon: "reports" },
      ],
    },
  ];
  if (hasGlobalManage(actor)) {
    groups.push({ label: "Operação", items: [{ href: "/classificacao", label: "Itens não classificados", icon: "inbox", badge: unclassified }] });
  }
  if (actor.globalRole === "superadmin") {
    groups.push({
      label: "Administração",
      items: [
        { href: "/admin", label: "Visão administrativa", icon: "admin" },
        { href: "/admin/ministerios", label: "Ministérios", icon: "ministries" },
        { href: "/admin/usuarios", label: "Usuários e convites", icon: "users" },
        { href: "/admin/integracoes", label: "Integrações", icon: "integrations" },
        { href: "/admin/sincronizacoes", label: "Sincronizações", icon: "sync" },
        { href: "/admin/auditoria", label: "Auditoria", icon: "audit" },
        { href: "/admin/configuracoes", label: "Configurações", icon: "settings" },
      ],
    });
  } else if (hasGlobalRead(actor)) {
    groups.push({ label: "Integrações", items: [{ href: "/admin/sincronizacoes", label: "Sincronizações", icon: "sync" }] });
  }

  const footer = (
    <div className="space-y-1">
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium">{actor.name}</p>
        <p className="truncate text-xs text-subtle">{GLOBAL_ROLE_LABEL[actor.globalRole]} · {actor.email}</p>
      </div>
      {isAgencyStaff(actor) ? (
        <form action={setModeAction}>
          <input type="hidden" name="mode" value={mode === "demo" ? "production" : "demo"} />
          <button type="submit" className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground">
            <FlaskConical className="size-[18px]" aria-hidden />
            {mode === "demo" ? "Sair do modo demonstração" : "Modo demonstração"}
          </button>
        </form>
      ) : null}
      <LogoutButton action={logoutAction} />
    </div>
  );
  const mark = <BrandMark name={brand.name} logoUrl={brand.logoUrl} />;

  return (
    <div className="min-h-dvh">
      <Sidebar brand={mark} groups={groups} footer={footer} />
      <MobileNav brand={mark} groups={groups} footer={footer} />
      <div className="lg:pl-64">
        {mode === "demo" ? (
          <div role="status" className="no-print flex items-center justify-center gap-2 bg-warning-soft px-4 py-2 text-center text-xs font-medium text-warning">
            <FlaskConical className="size-4" aria-hidden />
            MODO DEMONSTRAÇÃO — dados fictícios, isolados dos dados reais.
          </div>
        ) : null}
        <main id="conteudo" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
