"use client";

import { useActionState, useState } from "react";
import type { AdminActionState } from "@/components/admin/action-button";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Contraste (WCAG) do texto sobre a cor — espelha `contrastText` do servidor. */
function contrast(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return 1.05 / (lum + 0.05) >= 4.5 ? "#ffffff" : "#0f172a";
}

export function BrandingForm({ action, defaults }: {
  action: (prev: AdminActionState | null, form: FormData) => Promise<AdminActionState>;
  defaults: { name: string; organization: string; primaryColor: string; logoUrl: string | null };
}) {
  const [state, formAction] = useActionState(action, null);
  const [name, setName] = useState(defaults.name);
  const [org, setOrg] = useState(defaults.organization);
  const [color, setColor] = useState(defaults.primaryColor);
  const [logo, setLogo] = useState(defaults.logoUrl ?? "");
  const err = state?.ok ? {} : (state?.errors ?? {});
  const valid = HEX.test(color) ? color : defaults.primaryColor;
  const fg = contrast(valid);
  const logoOk = /^https:\/\/\S+$/.test(logo);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={formAction} className="space-y-3">
        <Field label="Nome do portal" htmlFor="b-name" error={err.name} required>
          <Input id="b-name" name="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} />
        </Field>
        <Field label="Organização" htmlFor="b-org" error={err.organization} required>
          <Input id="b-org" name="organization" value={org} onChange={(e) => setOrg(e.target.value)} required minLength={2} maxLength={80} />
        </Field>
        <Field label="Cor principal" htmlFor="b-color" error={err.primaryColor} hint="Usada em botões, links e destaques. O contraste do texto é ajustado automaticamente.">
          <div className="flex items-center gap-2">
            <input type="color" aria-label="Seletor de cor" value={valid} onChange={(e) => setColor(e.target.value)}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border-strong bg-surface p-1" />
            <Input id="b-color" name="primaryColor" value={color} onChange={(e) => setColor(e.target.value)} pattern="#[0-9a-fA-F]{6}" maxLength={7} required className="font-mono" />
          </div>
        </Field>
        <Field label="Logotipo (URL https)" htmlFor="b-logo" error={err.logoUrl} hint="Opcional. Imagem quadrada ou horizontal, hospedada em https.">
          <Input id="b-logo" name="logoUrl" type="url" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" />
        </Field>
        <FormMessage state={state} />
        <SubmitButton pendingLabel="Salvando…">Salvar identidade visual</SubmitButton>
      </form>
      <div aria-label="Pré-visualização" className="space-y-3">
        <p className="text-sm font-medium">Pré-visualização</p>
        <div className="overflow-hidden rounded-card border border-border shadow-card">
          <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: valid, color: fg }}>
            {logoOk ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="size-8 rounded bg-white/90 object-contain p-0.5" />
            ) : <span className="flex size-8 items-center justify-center rounded bg-white/20 text-sm font-bold">{name.slice(0, 1).toUpperCase() || "A"}</span>}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name || "Nome do portal"}</p>
              <p className="truncate text-xs opacity-80">{org || "Organização"}</p>
            </div>
          </div>
          <div className="space-y-3 bg-surface p-4">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium" style={{ backgroundColor: valid, color: fg }}>Botão principal</span>
              <span className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm font-medium" style={{ color: valid }}>Link de destaque</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-sunken"><div className="h-full w-2/3 rounded-full" style={{ backgroundColor: valid }} /></div>
            <p className="text-xs text-subtle">Contraste do texto sobre a cor: <span className="font-mono">{fg}</span></p>
          </div>
        </div>
      </div>
    </div>
  );
}
