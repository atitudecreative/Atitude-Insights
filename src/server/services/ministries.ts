import { z } from "zod";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { slugify } from "@/lib/format";
import { asUser, ministryAccess, ServiceError, zodErrors, type MinistryAccess } from "./context";
import type { DataMode } from "./mode";

export interface MinistrySummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  logo_url: string | null;
  status: string;
  is_demo: boolean;
}

const columns = ["id", "slug", "name", "description", "color", "logo_url", "status", "is_demo"] as const;

export async function listMinistries(actor: Actor, opts: { mode?: DataMode; includeArchived?: boolean } = {}): Promise<MinistrySummary[]> {
  return asUser(actor, async (trx) => {
    let q = trx.selectFrom("app.ministries").select(columns).orderBy("name");
    if (opts.mode) q = q.where("is_demo", "=", opts.mode === "demo");
    if (!opts.includeArchived) q = q.where("status", "=", "active");
    return q.execute();
  });
}

export async function getMinistryBySlug(actor: Actor, slug: string): Promise<{ ministry: MinistrySummary; access: MinistryAccess } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  return asUser(actor, async (trx) => {
    const ministry = await trx.selectFrom("app.ministries").select(columns).where("slug", "=", slug).executeTakeFirst();
    if (!ministry) return null;
    return { ministry, access: await ministryAccess(trx, ministry.id) };
  });
}

export async function getMinistryAccess(actor: Actor, ministryId: string): Promise<MinistryAccess> {
  return asUser(actor, (trx) => ministryAccess(trx, ministryId));
}

export const ministryInput = z.object({
  name: z.string().trim().min(2, "Informe o nome").max(120),
  slug: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional().transform((v) => v || null),
  color: z.union([z.literal(""), z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida")]).optional().transform((v) => v || null),
  logoUrl: z.union([z.literal(""), z.url().refine((u) => u.startsWith("https://"), "Use https")]).optional().transform((v) => v || null),
});

export async function createMinistry(actor: Actor, raw: unknown, isDemo = false): Promise<MinistrySummary> {
  const parsed = ministryInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const input = parsed.data;
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new ServiceError("Identificador inválido.", "invalid", { slug: ["Identificador inválido"] });
  return asUser(actor, async (trx) => {
    const row = await trx.insertInto("app.ministries")
      .values({ name: input.name, slug, description: input.description, color: input.color, logo_url: input.logoUrl, is_demo: isDemo })
      .returning(columns).executeTakeFirstOrThrow();
    await audit(trx, { ministryId: row.id, entityType: "ministry", entityId: row.id, action: "created", summary: `Ministério ${row.name} criado` });
    return row;
  });
}

export async function updateMinistry(actor: Actor, id: string, raw: unknown): Promise<void> {
  const parsed = ministryInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const input = parsed.data;
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.ministries")
      .set({ name: input.name, description: input.description, color: input.color, logo_url: input.logoUrl, ...(input.slug ? { slug: slugify(input.slug) } : {}) })
      .where("id", "=", id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Ministério não encontrado ou sem permissão.", "not_found");
    await audit(trx, { ministryId: id, entityType: "ministry", entityId: id, action: "updated", summary: `Ministério ${input.name} atualizado` });
  });
}

export async function setMinistryArchived(actor: Actor, id: string, archived: boolean): Promise<void> {
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.ministries")
      .set({ status: archived ? "archived" : "active", archived_at: archived ? new Date() : null })
      .where("id", "=", id).executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ServiceError("Ministério não encontrado ou sem permissão.", "not_found");
    await audit(trx, { ministryId: id, entityType: "ministry", entityId: id, action: archived ? "archived" : "restored" });
  });
}
