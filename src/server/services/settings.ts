import { z } from "zod";
import { systemDb } from "@/server/db";
import { env } from "@/server/env";
import type { Actor } from "@/server/auth/types";
import { audit } from "@/server/audit";
import { asUser, ServiceError } from "./context";
import type { Json } from "@/server/db/schema.generated";

export interface Branding {
  name: string;
  organization: string;
  primaryColor: string;
  logoUrl: string | null;
}

export const brandingSchema = z.object({
  name: z.string().trim().min(2).max(60),
  organization: z.string().trim().min(2).max(80),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor hexadecimal, ex.: #4f46e5"),
  logoUrl: z.union([z.literal(""), z.url().refine((u) => u.startsWith("https://"), "Use uma URL https")]).transform((v) => v || null),
});

/** Identidade visual: configuração no banco com fallback para variáveis de ambiente. */
export async function getBranding(): Promise<Branding> {
  const defaults: Branding = { name: env().BRAND_NAME, organization: env().BRAND_ORGANIZATION, primaryColor: env().BRAND_PRIMARY_COLOR, logoUrl: null };
  try {
    const row = await systemDb().selectFrom("app.app_settings").select("value").where("key", "=", "branding").executeTakeFirst();
    const parsed = brandingSchema.partial().safeParse(row?.value ?? {});
    return parsed.success ? { ...defaults, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) } : defaults;
  } catch {
    return defaults;
  }
}

export async function saveSetting(actor: Actor, key: string, value: unknown): Promise<void> {
  if (actor.globalRole !== "superadmin") throw new ServiceError("Apenas superadministradores alteram configurações.", "forbidden");
  await asUser(actor, async (trx) => {
    await trx.insertInto("app.app_settings").values({ key, value: JSON.stringify(value) as unknown as Json, updated_by: actor.userId })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) as unknown as Json, updated_by: actor.userId, updated_at: new Date() }))
      .execute();
    await audit(trx, { entityType: "settings", entityId: key, action: "settings_updated", changes: { key }, visibility: "admin" });
  });
}

/** Contraste do texto sobre a cor da marca (WCAG, luminância relativa). */
export function contrastText(hex: string): "#ffffff" | "#0f172a" {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (1.05 / (lum + 0.05)) >= 4.5 ? "#ffffff" : "#0f172a";
}
