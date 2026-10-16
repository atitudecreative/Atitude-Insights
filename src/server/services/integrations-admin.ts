import { z } from "zod";
import { systemDb } from "@/server/db";
import { env } from "@/server/env";
import { audit, auditSystem } from "@/server/audit";
import type { Actor } from "@/server/auth/types";
import { AsanaClient, type AsanaCustomFieldSetting, type AsanaSection } from "@/server/integrations/asana/client";
import { connectAsanaWithToken, testAsanaConnection, withAsanaAuth } from "@/server/integrations/asana/service";
import { loadCredentials, type KeyRing } from "@/server/integrations/credentials";
import { isDemoAccount } from "@/server/integrations/demo-account";
import { defaultHttpDeps, IntegrationError } from "@/server/integrations/http";
import { enqueueJob, processQueue, type IntegrationConfig, type JobType } from "@/server/integrations/jobs";
import { connectMetaWithToken, testMetaConnection, tokenDaysRemaining } from "@/server/integrations/meta/service";
import { jobRegistry } from "@/server/integrations/registry";
import { integrationConfig, keyRing } from "@/server/integrations/runtime";
import { randomToken, sha256 } from "@/server/security/crypto";
import { asUser, isUuid, ServiceError, zodErrors } from "./context";
import { assertSuperadmin } from "./users";

/**
 * Administração das integrações (Asana e Meta). Regras:
 *  - Tokens e segredos NUNCA saem do servidor nem são selecionados pelo
 *    papel da aplicação (credentials_encrypted não tem GRANT).
 *  - Leituras e alterações permitidas pela RLS usam `asUser`; conexão,
 *    teste, desconexão e execução de jobs usam `systemDb` (credenciais
 *    cifradas / fila) após `assertSuperadmin`.
 */

export type Provider = "asana" | "meta";

/** Chaves, configuração de apps e versão da Graph API (somente no servidor). */
export function integrationRuntime(): { keys: KeyRing; config: IntegrationConfig; graphVersion: string } {
  return { keys: keyRing(), config: integrationConfig(), graphVersion: env().META_GRAPH_VERSION };
}

export function oauthRedirectUri(provider: Provider): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/integrations/${provider}/callback`;
}

function integrationMessage(error: unknown, fallback: string): string {
  if (error instanceof IntegrationError) {
    if (error.kind === "auth") return "Token inválido, expirado ou sem as permissões necessárias.";
    if (error.kind === "permission") return "O token não tem permissão para acessar este recurso.";
    if (error.kind === "rate_limit") return "Limite de requisições do provedor atingido. Tente novamente em alguns minutos.";
    if (error.kind === "transient") return "O provedor está indisponível no momento. Tente novamente.";
    return error.message.slice(0, 300);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
const ACCOUNT_COLUMNS = [
  "a.id", "a.provider", "a.label", "a.auth_type", "a.status", "a.token_expires_at", "a.scopes", "a.external_user_id", "a.external_user_name",
  "a.sync_enabled", "a.last_tested_at", "a.last_test_ok", "a.last_error", "a.last_error_at", "a.last_sync_at", "a.last_successful_sync_at", "a.created_at",
] as const;

export async function listIntegrationAccounts(actor: Actor) {
  assertSuperadmin(actor);
  const rows = await asUser(actor, (trx) => trx.selectFrom("app.connected_accounts as a")
    .select([
      ...ACCOUNT_COLUMNS,
      (eb) => eb.selectFrom("app.external_assets as x").select(eb.fn.countAll<number>().as("n")).whereRef("x.connected_account_id", "=", "a.id").where("x.removed_at", "is", null).as("assets"),
      (eb) => eb.selectFrom("app.external_assets as x").select(eb.fn.countAll<number>().as("n")).whereRef("x.connected_account_id", "=", "a.id").where("x.sync_enabled", "=", true).where("x.removed_at", "is", null).as("assets_enabled"),
      (eb) => eb.selectFrom("app.sync_jobs as j").select(eb.fn.countAll<number>().as("n")).whereRef("j.connected_account_id", "=", "a.id").where("j.status", "in", ["queued", "running"]).as("active_jobs"),
    ])
    .orderBy("a.provider").orderBy("a.created_at").execute());
  return rows.map((r) => ({
    ...r,
    assets: Number(r.assets ?? 0), assets_enabled: Number(r.assets_enabled ?? 0), active_jobs: Number(r.active_jobs ?? 0),
    is_demo: isDemoAccount(r),
    days_remaining: r.provider === "meta" ? tokenDaysRemaining(r.token_expires_at) : null,
  }));
}

export type IntegrationAccount = Awaited<ReturnType<typeof listIntegrationAccounts>>[number];

/** Estado agregado do provedor para os cartões de status. */
export function providerStatus(provider: Provider, accounts: IntegrationAccount[]): string {
  const list = accounts.filter((a) => a.provider === provider && a.status !== "disconnected" && !a.is_demo);
  if (!list.length) return "not_configured";
  for (const s of ["error", "expired", "revoked", "syncing", "pending"]) if (list.some((a) => a.status === s)) return s;
  return "connected";
}

export async function getIntegrationAccount(actor: Actor, id: string) {
  assertSuperadmin(actor);
  if (!isUuid(id)) return null;
  return asUser(actor, async (trx) => {
    const account = await trx.selectFrom("app.connected_accounts as a").select([...ACCOUNT_COLUMNS]).where("a.id", "=", id).executeTakeFirst();
    if (!account) return null;
    const assets = await trx.selectFrom("app.external_assets").select(["id", "asset_type", "external_id", "name", "parent_asset_id", "metadata", "sync_enabled", "last_synced_at", "removed_at"])
      .where("connected_account_id", "=", id).orderBy("asset_type").orderBy("name").execute();
    const assetIds = assets.map((a) => a.id);
    const [mappings, availability, rules, ministries, campaigns, events] = await Promise.all([
      assetIds.length
        ? trx.selectFrom("app.asset_ministry_mappings as am").innerJoin("app.ministries as m", "m.id", "am.ministry_id")
          .select(["am.id", "am.external_asset_id", "am.ministry_id", "m.name as ministry_name", "m.is_demo"])
          .where("am.external_asset_id", "in", assetIds).orderBy("m.name").execute()
        : Promise.resolve([]),
      assetIds.length
        ? trx.selectFrom("app.metric_availability").select(["id", "external_asset_id", "metric_key", "scope", "available", "reason", "checked_at"])
          .where("external_asset_id", "in", assetIds).orderBy("metric_key").execute()
        : Promise.resolve([]),
      trx.selectFrom("app.mapping_rules as r").innerJoin("app.ministries as m", "m.id", "r.ministry_id")
        .leftJoin("app.campaigns as c", "c.id", "r.campaign_id").leftJoin("app.events as e", "e.id", "r.event_id")
        .leftJoin("app.external_assets as x", "x.id", "r.external_asset_id")
        .select(["r.id", "r.rule_type", "r.external_asset_id", "r.match_field", "r.match_value", "r.ministry_id", "r.campaign_id", "r.event_id",
          "r.priority", "r.active", "m.name as ministry_name", "c.name as campaign_name", "e.name as event_name", "x.name as asset_name"])
        .where("r.provider", "=", account.provider).orderBy("r.priority").orderBy("r.created_at").execute(),
      trx.selectFrom("app.ministries").select(["id", "name", "is_demo", "status"]).orderBy("is_demo").orderBy("name").execute(),
      trx.selectFrom("app.campaigns").select(["id", "name", "ministry_id"]).where("status", "<>", "archived").orderBy("name").limit(500).execute(),
      trx.selectFrom("app.events").select(["id", "name", "ministry_id"]).where("archived_at", "is", null).orderBy("starts_at", "desc").limit(500).execute(),
    ]);
    return {
      account: { ...account, is_demo: isDemoAccount(account), days_remaining: account.provider === "meta" ? tokenDaysRemaining(account.token_expires_at) : null },
      assets, mappings, availability, rules, ministries, campaigns, events,
    };
  });
}

/**
 * Seções e campos personalizados de um projeto do Asana, consultados ao vivo
 * com a credencial da conta (decifrada apenas no servidor).
 */
export async function asanaProjectStructure(actor: Actor, accountId: string, assetId: string): Promise<
  { ok: true; sections: AsanaSection[]; customFields: AsanaCustomFieldSetting[] } | { ok: false; message: string }
> {
  assertSuperadmin(actor);
  if (!isUuid(accountId) || !isUuid(assetId)) return { ok: false, message: "Projeto inválido." };
  const db = systemDb();
  const asset = await db.selectFrom("app.external_assets as x").innerJoin("app.connected_accounts as a", "a.id", "x.connected_account_id")
    .select(["x.external_id", "x.asset_type", "a.id as account_id", "a.auth_type", "a.status", "a.external_user_id"])
    .where("x.id", "=", assetId).where("x.connected_account_id", "=", accountId).executeTakeFirst();
  if (!asset || asset.asset_type !== "asana_project") return { ok: false, message: "Projeto do Asana não encontrado nesta conta." };
  if (isDemoAccount(asset)) return { ok: false, message: "Conta de demonstração: sem acesso ao Asana." };
  const { keys, config } = integrationRuntime();
  try {
    const credentials = await loadCredentials(db, accountId, keys);
    if (!credentials) return { ok: false, message: "Credenciais ausentes — reconecte a conta." };
    const auth = { db, accountId, authType: asset.auth_type, credentials, keys, config, http: defaultHttpDeps };
    const [sections, customFields] = await withAsanaAuth(auth, (client: AsanaClient) => Promise.all([
      client.listSections(asset.external_id), client.listCustomFieldSettings(asset.external_id),
    ]));
    return { ok: true, sections, customFields };
  } catch (error) {
    return { ok: false, message: integrationMessage(error, "Não foi possível consultar o Asana agora.") };
  }
}

// ---------------------------------------------------------------------------
// Conexão por token
// ---------------------------------------------------------------------------
const tokenInput = z.object({
  label: z.string().trim().max(120).default(""),
  token: z.string().trim().min(10, "Informe o token").max(2000),
});

export async function connectWithToken(actor: Actor, provider: Provider, raw: unknown): Promise<string> {
  assertSuperadmin(actor);
  const parsed = tokenInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  const { keys, config, graphVersion } = integrationRuntime();
  const db = systemDb();
  let accountId: string;
  try {
    if (provider === "asana") {
      accountId = await connectAsanaWithToken(db, { label: parsed.data.label, token: parsed.data.token, createdBy: actor.userId }, keys);
    } else {
      const r = await connectMetaWithToken(db, { label: parsed.data.label || "Meta — Usuário do Sistema", token: parsed.data.token, createdBy: actor.userId }, keys, config, graphVersion);
      accountId = r.accountId;
    }
  } catch (error) {
    throw new ServiceError(`Não foi possível conectar: ${integrationMessage(error, "erro inesperado.")}`, "invalid");
  }
  await auditSystem(db, actor.userId, {
    entityType: "connected_account", entityId: accountId, action: "integration_connected", visibility: "admin",
    summary: `Conta ${provider === "asana" ? "do Asana" : "da Meta"} conectada por token`, changes: { provider, authType: "personal_token" },
  });
  return accountId;
}

// ---------------------------------------------------------------------------
// OAuth (estado anti-CSRF)
// ---------------------------------------------------------------------------
const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Cria o estado OAuth (apenas o hash é persistido) e devolve o valor bruto. */
export async function createOAuthState(actor: Actor, provider: Provider, opts: { label?: string | null; codeVerifier?: string | null }): Promise<string> {
  assertSuperadmin(actor);
  const state = randomToken(32);
  const db = systemDb();
  // Limpeza oportunista de estados vencidos.
  await db.deleteFrom("app.oauth_states").where("expires_at", "<", new Date(Date.now() - 86400_000)).execute();
  await db.insertInto("app.oauth_states").values({
    state_hash: sha256(state), provider, user_id: actor.userId, code_verifier: opts.codeVerifier ?? null,
    label: opts.label?.trim().slice(0, 120) || null, expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  }).execute();
  return state;
}

/**
 * Valida e consome o estado: precisa existir, não ter sido usado, não estar
 * vencido e pertencer ao MESMO usuário que iniciou o fluxo. Uso único
 * garantido pelo UPDATE condicional.
 */
export async function consumeOAuthState(actor: Actor, provider: Provider, state: string | null): Promise<{ codeVerifier: string | null; label: string | null } | null> {
  if (actor.globalRole !== "superadmin" || !state || state.length > 200) return null;
  const row = await systemDb().updateTable("app.oauth_states").set({ used_at: new Date() })
    .where("state_hash", "=", sha256(state)).where("provider", "=", provider).where("user_id", "=", actor.userId)
    .where("used_at", "is", null).where("expires_at", ">", new Date())
    .returning(["code_verifier", "label"]).executeTakeFirst();
  return row ? { codeVerifier: row.code_verifier, label: row.label } : null;
}

// ---------------------------------------------------------------------------
// Ações sobre contas
// ---------------------------------------------------------------------------
async function loadAccount(id: string) {
  if (!isUuid(id)) throw new ServiceError("Conta inválida.", "invalid");
  const account = await systemDb().selectFrom("app.connected_accounts").select(["id", "provider", "label", "status", "external_user_id"])
    .where("id", "=", id).executeTakeFirst();
  if (!account) throw new ServiceError("Conta não encontrada.", "not_found");
  return account as typeof account & { provider: Provider };
}

export async function testConnection(actor: Actor, accountId: string): Promise<{ ok: boolean; message: string }> {
  assertSuperadmin(actor);
  const account = await loadAccount(accountId);
  if (isDemoAccount(account)) return { ok: false, message: "Conta de demonstração: não há conexão real para testar." };
  if (account.status === "disconnected") return { ok: false, message: "Conta desconectada. Conecte novamente." };
  const { keys, config, graphVersion } = integrationRuntime();
  const db = systemDb();
  let result: { ok: boolean; message: string };
  try {
    result = account.provider === "asana"
      ? await testAsanaConnection(db, accountId, keys, config)
      : await testMetaConnection(db, accountId, keys, config, graphVersion);
  } catch (error) {
    result = { ok: false, message: integrationMessage(error, "Falha ao testar a conexão.") };
  }
  await auditSystem(db, actor.userId, {
    entityType: "connected_account", entityId: accountId, action: "integration_tested", visibility: "admin",
    summary: result.ok ? "Teste de conexão bem-sucedido" : "Teste de conexão falhou", changes: { ok: result.ok },
  });
  return result;
}

export type SyncKind = "sync" | "discover" | "reclassify";

const JOBS_FOR: Record<Provider, Record<SyncKind, JobType[]>> = {
  asana: { sync: ["asana_incremental"], discover: ["asana_discover"], reclassify: ["asana_full"] },
  meta: { sync: ["meta_ads", "meta_organic"], discover: ["meta_discover"], reclassify: ["meta_ads", "meta_organic"] },
};

/**
 * Enfileira jobs e, opcionalmente, processa a fila por até ~25 s para que o
 * administrador veja o resultado em seguida (o restante segue no cron).
 */
export async function runSync(actor: Actor, accountId: string, kind: SyncKind, opts: { inline?: boolean } = {}) {
  assertSuperadmin(actor);
  const account = await loadAccount(accountId);
  if (isDemoAccount(account)) throw new ServiceError("A conta de demonstração não sincroniza (dados fictícios).", "invalid");
  if (account.status === "disconnected" || account.status === "revoked") throw new ServiceError("Conecte a conta novamente antes de sincronizar.", "invalid");
  const types = JOBS_FOR[account.provider][kind];
  const jobs = await asUser(actor, async (trx) => {
    const out: Array<{ id: string; created: boolean; type: JobType }> = [];
    for (const jobType of types) {
      // RLS: sync_jobs_insert exige superadministrador.
      const r = await enqueueJob(trx, { accountId, provider: account.provider, jobType, trigger: "manual", requestedBy: actor.userId });
      out.push({ ...r, type: jobType });
    }
    await audit(trx, {
      entityType: "connected_account", entityId: accountId, action: kind === "reclassify" ? "integration_reclassify" : kind === "discover" ? "integration_discover" : "integration_sync",
      summary: `Sincronização manual enfileirada (${types.join(", ")})`, visibility: "admin",
    });
    return out;
  });
  let results: Array<{ jobId: string; status: string }> = [];
  if (opts.inline) {
    const { keys, config, graphVersion } = integrationRuntime();
    results = await processQueue(systemDb(), { registry: jobRegistry, keys, config, graphVersion, budgetMs: 25_000, maxJobs: jobs.length + 2 });
  }
  return { jobs, results };
}

export async function retryJob(actor: Actor, jobId: string): Promise<string> {
  assertSuperadmin(actor);
  if (!isUuid(jobId)) throw new ServiceError("Job inválido.", "invalid");
  return asUser(actor, async (trx) => {
    const job = await trx.selectFrom("app.sync_jobs").select(["id", "status", "job_type", "provider", "connected_account_id"]).where("id", "=", jobId).executeTakeFirst();
    if (!job || !job.connected_account_id) throw new ServiceError("Job não encontrado.", "not_found");
    if (job.status !== "failed" && job.status !== "cancelled" && job.status !== "partial") throw new ServiceError("Apenas jobs com falha podem ser reexecutados.", "invalid");
    const account = await trx.selectFrom("app.connected_accounts").select(["status", "external_user_id"]).where("id", "=", job.connected_account_id).executeTakeFirst();
    if (!account || account.status === "disconnected" || isDemoAccount(account)) throw new ServiceError("A conta deste job não está disponível para sincronização.", "invalid");
    const r = await enqueueJob(trx, {
      accountId: job.connected_account_id, provider: job.provider as Provider, jobType: job.job_type as JobType, trigger: "retry", requestedBy: actor.userId,
    });
    await audit(trx, { entityType: "sync_job", entityId: r.id, action: "sync_job_retried", summary: `Reexecução do job ${jobId}`, visibility: "admin", changes: { originalJobId: jobId } });
    return r.id;
  });
}

/** Desconecta: status 'disconnected', apaga a credencial cifrada e cancela jobs na fila. */
export async function disconnectAccount(actor: Actor, accountId: string): Promise<void> {
  assertSuperadmin(actor);
  const account = await loadAccount(accountId);
  const db = systemDb();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("app.connected_accounts")
      .set({ status: "disconnected", credentials_encrypted: null, sync_enabled: false, token_expires_at: null })
      .where("id", "=", accountId).execute();
    await trx.updateTable("app.sync_jobs").set({ status: "cancelled", finished_at: new Date(), error: "Conta desconectada", locked_until: null })
      .where("connected_account_id", "=", accountId).where("status", "=", "queued").execute();
    await auditSystem(trx, actor.userId, {
      entityType: "connected_account", entityId: accountId, action: "integration_disconnected", visibility: "admin",
      summary: `Conta "${account.label}" desconectada; credencial removida`,
    });
  });
}

export async function updateAccountSettings(actor: Actor, accountId: string, raw: unknown): Promise<void> {
  assertSuperadmin(actor);
  const parsed = z.object({ label: z.string().trim().min(2, "Informe um nome").max(120), syncEnabled: z.boolean() }).safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos.", "invalid", zodErrors(parsed.error.issues));
  await asUser(actor, async (trx) => {
    const current = await trx.selectFrom("app.connected_accounts").select(["external_user_id"]).where("id", "=", accountId).executeTakeFirst();
    if (!current) throw new ServiceError("Conta não encontrada.", "not_found");
    const syncEnabled = isDemoAccount(current) ? false : parsed.data.syncEnabled;
    await trx.updateTable("app.connected_accounts").set({ label: parsed.data.label, sync_enabled: syncEnabled }).where("id", "=", accountId).execute();
    await audit(trx, { entityType: "connected_account", entityId: accountId, action: "integration_updated", visibility: "admin", changes: { label: parsed.data.label, syncEnabled } });
  });
}

export async function setAssetSyncEnabled(actor: Actor, assetId: string, enabled: boolean): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(assetId)) throw new ServiceError("Ativo inválido.", "invalid");
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.external_assets").set({ sync_enabled: enabled }).where("id", "=", assetId).returning(["name"]).executeTakeFirst();
    if (!r) throw new ServiceError("Ativo não encontrado.", "not_found");
    await audit(trx, { entityType: "external_asset", entityId: assetId, action: enabled ? "asset_sync_enabled" : "asset_sync_disabled", summary: r.name, visibility: "admin" });
  });
}

export async function addAssetMapping(actor: Actor, assetId: string, ministryId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(assetId) || !isUuid(ministryId)) throw new ServiceError("Selecione o ministério.", "invalid", { ministryId: ["Selecione o ministério"] });
  await asUser(actor, async (trx) => {
    const exists = await trx.selectFrom("app.asset_ministry_mappings").select("id").where("external_asset_id", "=", assetId).where("ministry_id", "=", ministryId).executeTakeFirst();
    if (exists) throw new ServiceError("Este ativo já está associado ao ministério.", "conflict");
    await trx.insertInto("app.asset_ministry_mappings").values({ external_asset_id: assetId, ministry_id: ministryId, created_by: actor.userId }).execute();
    await audit(trx, { ministryId, entityType: "external_asset", entityId: assetId, action: "asset_mapping_added", summary: "Ativo associado ao ministério", visibility: "admin" });
  });
}

export async function removeAssetMapping(actor: Actor, mappingId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(mappingId)) throw new ServiceError("Associação inválida.", "invalid");
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.asset_ministry_mappings").where("id", "=", mappingId).returning(["external_asset_id", "ministry_id"]).executeTakeFirst();
    if (!r) throw new ServiceError("Associação não encontrada.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "external_asset", entityId: r.external_asset_id, action: "asset_mapping_removed", summary: "Associação removida", visibility: "admin" });
  });
}

// ---------------------------------------------------------------------------
// Regras de classificação
// ---------------------------------------------------------------------------
const optionalUuid = z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null);

export const mappingRuleInput = z.object({
  provider: z.enum(["asana", "meta"]),
  ruleType: z.enum(["asana_project", "asana_section", "asana_tag", "asana_custom_field", "meta_campaign_name_prefix"], "Selecione o tipo de regra"),
  externalAssetId: optionalUuid,
  matchField: z.string().trim().max(200).optional().transform((v) => v || null),
  matchValue: z.string().trim().max(300).optional().transform((v) => v || null),
  ministryId: z.uuid("Selecione o ministério"),
  campaignId: optionalUuid,
  eventId: optionalUuid,
  priority: z.coerce.number().int().min(1, "Mínimo 1").max(1000, "Máximo 1000").default(100),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  const asanaTypes = ["asana_project", "asana_section", "asana_tag", "asana_custom_field"];
  if (v.provider === "asana" && !asanaTypes.includes(v.ruleType)) ctx.addIssue({ code: "custom", message: "Tipo de regra inválido para o Asana", path: ["ruleType"] });
  if (v.provider === "meta" && v.ruleType !== "meta_campaign_name_prefix") ctx.addIssue({ code: "custom", message: "Tipo de regra inválido para a Meta", path: ["ruleType"] });
  if (v.ruleType === "asana_project" && !v.externalAssetId) ctx.addIssue({ code: "custom", message: "Selecione o projeto", path: ["externalAssetId"] });
  if (v.ruleType !== "asana_project" && !v.matchValue) ctx.addIssue({ code: "custom", message: "Informe o valor a comparar", path: ["matchValue"] });
  if (v.ruleType === "asana_custom_field" && !v.matchField) ctx.addIssue({ code: "custom", message: "Informe o campo personalizado", path: ["matchField"] });
});

export async function saveMappingRule(actor: Actor, ruleId: string | null, raw: unknown): Promise<string> {
  assertSuperadmin(actor);
  const parsed = mappingRuleInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError("Verifique os campos da regra.", "invalid", zodErrors(parsed.error.issues));
  const v = parsed.data;
  const values = {
    provider: v.provider, rule_type: v.ruleType, external_asset_id: v.externalAssetId,
    match_field: v.ruleType === "asana_custom_field" ? v.matchField : null,
    match_value: v.ruleType === "asana_project" ? null : v.matchValue,
    ministry_id: v.ministryId, campaign_id: v.campaignId, event_id: v.eventId, priority: v.priority, active: v.active,
  };
  return asUser(actor, async (trx) => {
    let id: string;
    if (ruleId) {
      if (!isUuid(ruleId)) throw new ServiceError("Regra inválida.", "invalid");
      const r = await trx.updateTable("app.mapping_rules").set(values).where("id", "=", ruleId).returning("id").executeTakeFirst();
      if (!r) throw new ServiceError("Regra não encontrada.", "not_found");
      id = r.id;
    } else {
      id = (await trx.insertInto("app.mapping_rules").values({ ...values, created_by: actor.userId }).returning("id").executeTakeFirstOrThrow()).id;
    }
    await audit(trx, {
      ministryId: v.ministryId, entityType: "mapping_rule", entityId: id, action: ruleId ? "mapping_rule_updated" : "mapping_rule_created",
      summary: `Regra ${v.ruleType}${v.matchValue ? ` = ${v.matchValue}` : ""}`, visibility: "admin", changes: values,
    });
    return id;
  });
}

export async function setMappingRuleActive(actor: Actor, ruleId: string, active: boolean): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(ruleId)) throw new ServiceError("Regra inválida.", "invalid");
  await asUser(actor, async (trx) => {
    const r = await trx.updateTable("app.mapping_rules").set({ active }).where("id", "=", ruleId).returning(["ministry_id"]).executeTakeFirst();
    if (!r) throw new ServiceError("Regra não encontrada.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "mapping_rule", entityId: ruleId, action: active ? "mapping_rule_enabled" : "mapping_rule_disabled", visibility: "admin" });
  });
}

export async function deleteMappingRule(actor: Actor, ruleId: string): Promise<void> {
  assertSuperadmin(actor);
  if (!isUuid(ruleId)) throw new ServiceError("Regra inválida.", "invalid");
  await asUser(actor, async (trx) => {
    const r = await trx.deleteFrom("app.mapping_rules").where("id", "=", ruleId).returning(["ministry_id", "rule_type", "match_value"]).executeTakeFirst();
    if (!r) throw new ServiceError("Regra não encontrada.", "not_found");
    await audit(trx, { ministryId: r.ministry_id, entityType: "mapping_rule", entityId: ruleId, action: "mapping_rule_deleted", summary: `Regra ${r.rule_type} removida`, visibility: "admin" });
  });
}
