"use client";

import {
  BarChart3, Building2, CalendarDays, FileText, Inbox, LayoutDashboard, ListChecks, LogOut, Megaphone, Menu, Package,
  PlugZap, RefreshCw, ScrollText, Settings, Shield, Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Sheet } from "@/components/ui/dialog";

const ICONS = {
  dashboard: LayoutDashboard, ministries: Building2, campaigns: Megaphone, events: CalendarDays, tasks: ListChecks,
  deliverables: Package, results: BarChart3, reports: FileText, admin: Shield, users: Users, integrations: PlugZap,
  inbox: Inbox, sync: RefreshCw, audit: ScrollText, settings: Settings,
} as const;

export interface NavItem { href: string; label: string; icon: keyof typeof ICONS; badge?: number }
export interface NavGroup { label?: string; items: NavItem[] }

function NavLinks({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-5">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi}>
          {g.label ? <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">{g.label}</p> : null}
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`));
              return (
                <li key={item.href}>
                  <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                    className={cn("flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                      active ? "bg-brand-soft text-brand" : "text-muted hover:bg-surface-muted hover:text-foreground")}>
                    <Icon className="size-[18px] shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge ? <span className="rounded-full bg-warning-soft px-1.5 text-xs font-semibold text-warning">{item.badge}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ brand, groups, footer }: { brand: ReactNode; groups: NavGroup[]; footer: ReactNode }) {
  return (
    <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center px-5">{brand}</div>
      <div className="flex-1 overflow-y-auto px-3 py-3"><NavLinks groups={groups} /></div>
      <div className="border-t border-border p-3">{footer}</div>
    </aside>
  );
}

export function MobileNav({ brand, groups, footer }: { brand: ReactNode; groups: NavGroup[]; footer: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
      <Link href="/" className="min-w-0">{brand}</Link>
      <Sheet open={open} onOpenChange={setOpen} title="Menu"
        trigger={<button type="button" className="-mr-2 flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-muted" aria-label="Abrir menu"><Menu className="size-5" /></button>}>
        <div className="flex min-h-full flex-col gap-6">
          <NavLinks groups={groups} onNavigate={() => setOpen(false)} />
          <div className="mt-auto border-t border-border pt-3">{footer}</div>
        </div>
      </Sheet>
    </header>
  );
}

export function LogoutButton({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action}>
      <button type="submit" className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground">
        <LogOut className="size-[18px]" aria-hidden /> Sair
      </button>
    </form>
  );
}
