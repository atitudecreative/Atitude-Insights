import { Field, Input, Textarea } from "@/components/ui/form";

export interface MinistryDefaults {
  name?: string; slug?: string; description?: string | null; color?: string | null; logo_url?: string | null;
}

/** Campos do cadastro de ministério (usados no diálogo de criação e na edição). */
export function MinistryFields({ defaults = {}, idPrefix }: { defaults?: MinistryDefaults; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Nome" htmlFor={id("name")} required className="sm:col-span-2">
        <Input id={id("name")} name="name" defaultValue={defaults.name} required minLength={2} maxLength={120} />
      </Field>
      <Field label="Identificador (slug)" htmlFor={id("slug")} hint="Usado na URL. Gerado a partir do nome se ficar em branco.">
        <Input id={id("slug")} name="slug" defaultValue={defaults.slug} maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="atitude-kids" />
      </Field>
      <Field label="Cor" htmlFor={id("color")} hint="Hexadecimal, ex.: #f59e0b">
        <Input id={id("color")} name="color" defaultValue={defaults.color ?? ""} pattern="#[0-9a-fA-F]{6}" placeholder="#4f46e5" maxLength={7} />
      </Field>
      <Field label="Logotipo (URL https)" htmlFor={id("logo")} className="sm:col-span-2">
        <Input id={id("logo")} name="logoUrl" type="url" defaultValue={defaults.logo_url ?? ""} placeholder="https://…" />
      </Field>
      <Field label="Descrição" htmlFor={id("description")} className="sm:col-span-2">
        <Textarea id={id("description")} name="description" defaultValue={defaults.description ?? ""} maxLength={2000} />
      </Field>
    </div>
  );
}
