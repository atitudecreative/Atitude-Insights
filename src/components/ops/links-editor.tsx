"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

interface LinkRow { key: number; label: string; url: string }

/**
 * Lista dinâmica de links (rótulo + URL). Os itens preenchidos são enviados
 * como JSON em um campo oculto e validados no servidor.
 */
export function LinksEditor({ name, defaultValue = [], error }: { name: string; defaultValue?: Array<{ label: string; url: string }>; error?: string | string[] }) {
  const [rows, setRows] = useState<LinkRow[]>(() => defaultValue.map((l, i) => ({ key: i, label: l.label, url: l.url })));
  const [next, setNext] = useState(defaultValue.length);
  const filled = rows.filter((r) => r.label.trim() || r.url.trim()).map((r) => ({ label: r.label.trim(), url: r.url.trim() }));
  const message = Array.isArray(error) ? error[0] : error;
  const update = (key: number, patch: Partial<LinkRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={JSON.stringify(filled)} />
      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
              <Input aria-label={`Rótulo do link ${i + 1}`} placeholder="Rótulo (ex.: Inscrições)" value={r.label} maxLength={100}
                onChange={(e) => update(r.key, { label: e.target.value })} />
              <Input aria-label={`URL do link ${i + 1}`} placeholder="https://" type="url" inputMode="url" value={r.url}
                onChange={(e) => update(r.key, { url: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remover link ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-subtle">Nenhum link adicionado.</p>}
      {message ? <p className="text-xs text-danger" role="alert">{message}</p> : null}
      {rows.length < 20 ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => { setRows((rs) => [...rs, { key: next, label: "", url: "" }]); setNext((n) => n + 1); }}>
          <Plus /> Adicionar link
        </Button>
      ) : null}
    </div>
  );
}
