import type { Kysely } from "kysely";
import type { DB } from "../../src/server/db/schema.generated";

type Db = Kysely<DB>;
let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function makeUser(
  db: Db,
  opts: { role?: "superadmin" | "agency" | "ministry"; access?: "none" | "read" | "manage"; name?: string; status?: "active" | "disabled" } = {},
) {
  const id = uniq();
  return db
    .insertInto("app.users")
    .values({
      email: `user-${id}@example.test`,
      name: opts.name ?? `Usuário ${id}`,
      global_role: opts.role ?? "ministry",
      agency_global_access: opts.role === "agency" ? (opts.access ?? "none") : "none",
      status: opts.status ?? "active",
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();
}

export async function makeMinistry(db: Db, name = `Ministério ${uniq()}`, isDemo = false) {
  const slug = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + uniq();
  return db.insertInto("app.ministries").values({ name, slug, is_demo: isDemo }).returning(["id", "name"]).executeTakeFirstOrThrow();
}

export async function addMember(
  db: Db,
  userId: string,
  ministryId: string,
  role: "agency_manager" | "agency_viewer" | "leader" | "operational",
  canViewInvestment = false,
) {
  await db.insertInto("app.ministry_memberships").values({ user_id: userId, ministry_id: ministryId, role, can_view_investment: canViewInvestment }).execute();
}

export async function makeCampaign(db: Db, ministryId: string, name = `Campanha ${uniq()}`) {
  return db.insertInto("app.campaigns").values({ ministry_id: ministryId, name, status: "active", start_date: "2026-01-01", end_date: "2026-12-31" })
    .returning(["id", "name"]).executeTakeFirstOrThrow();
}

export async function makeEvent(db: Db, ministryId: string, name = `Evento ${uniq()}`) {
  return db.insertInto("app.events").values({ ministry_id: ministryId, name, starts_at: new Date("2026-06-10T19:00:00Z") })
    .returning(["id", "name"]).executeTakeFirstOrThrow();
}

export async function makeConnectedAccount(db: Db, provider: "asana" | "meta" = "meta") {
  return db.insertInto("app.connected_accounts").values({
    provider, label: `${provider} ${uniq()}`, auth_type: "personal_token", status: "connected",
    credentials_encrypted: "v1.secret.secret.secret",
  }).returning(["id"]).executeTakeFirstOrThrow();
}

export async function makeAsset(db: Db, accountId: string, type: "meta_ad_account" | "instagram_account" | "facebook_page" | "asana_project" | "asana_workspace" = "meta_ad_account") {
  return db.insertInto("app.external_assets").values({
    connected_account_id: accountId, provider: type.startsWith("asana") ? "asana" : "meta", asset_type: type,
    external_id: `ext-${uniq()}`, name: `Ativo ${uniq()}`, sync_enabled: true,
  }).returning(["id", "external_id"]).executeTakeFirstOrThrow();
}

export async function makeExternalCampaign(db: Db, assetId: string, ministryId: string | null) {
  return db.insertInto("app.external_campaigns").values({
    external_asset_id: assetId, external_id: `cmp-${uniq()}`, name: `Meta ${uniq()}`, ministry_id: ministryId,
    classification: ministryId ? "auto" : "unclassified",
  }).returning(["id"]).executeTakeFirstOrThrow();
}

export async function addObservation(
  db: Db,
  o: { metric: string; ministryId: string | null; entityId: string; value: number; day: string; source?: "meta_ads" | "instagram" | "facebook"; entityType?: "meta_campaign" | "social_post" | "external_asset"; dimension?: string; granularity?: "day" | "lifetime" | "snapshot"; periodStart?: string },
) {
  await db.insertInto("app.metric_observations").values({
    metric_key: o.metric, source: o.source ?? "meta_ads", ministry_id: o.ministryId, entity_type: o.entityType ?? "meta_campaign",
    entity_id: o.entityId, granularity: o.granularity ?? "day", period_start: o.periodStart ?? o.day, period_end: o.day, value: o.value,
    dimension_key: o.dimension ?? "",
  }).execute();
}
