import type { Actor } from "@/server/auth/types";
import { asUser } from "./context";
import type { DataMode } from "./mode";

/** Opções de filtro limitadas ao escopo do usuário (RLS). */
export async function filterOptions(actor: Actor, mode: DataMode, ministryId?: string) {
  return asUser(actor, async (trx) => {
    const [ministries, campaigns, events] = await Promise.all([
      trx.selectFrom("app.ministries").select(["id", "name", "slug"]).where("is_demo", "=", mode === "demo").where("status", "=", "active").orderBy("name").execute(),
      (() => {
        let q = trx.selectFrom("app.campaigns as c").innerJoin("app.ministries as m", "m.id", "c.ministry_id")
          .select(["c.id", "c.name", "c.ministry_id"]).where("m.is_demo", "=", mode === "demo").where("c.status", "<>", "archived");
        if (ministryId) q = q.where("c.ministry_id", "=", ministryId);
        return q.orderBy("c.name").limit(300).execute();
      })(),
      (() => {
        let q = trx.selectFrom("app.events as e").innerJoin("app.ministries as m", "m.id", "e.ministry_id")
          .select(["e.id", "e.name", "e.ministry_id"]).where("m.is_demo", "=", mode === "demo").where("e.archived_at", "is", null);
        if (ministryId) q = q.where("e.ministry_id", "=", ministryId);
        return q.orderBy("e.starts_at", "desc").limit(300).execute();
      })(),
    ]);
    return { ministries, campaigns, events };
  });
}

export const CHANNEL_FILTER = [
  { value: "meta_ads", label: "Meta Ads (pago)" },
  { value: "instagram", label: "Instagram (orgânico)" },
  { value: "facebook", label: "Facebook (orgânico)" },
];
