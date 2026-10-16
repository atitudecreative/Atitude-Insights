import { systemDb, type Database, type Tx } from "@/server/db";
import { auditSystem } from "@/server/audit";
import type { Actor } from "@/server/auth/types";
import type { Json } from "@/server/db/schema.generated";
import { DEMO_ACCOUNT_EXTERNAL_ID, DEMO_ACCOUNT_LABEL } from "@/server/integrations/demo-account";
import { addDays, todayIso } from "@/lib/period";
import { ServiceError } from "./context";

/**
 * Dados de DEMONSTRAÇÃO, claramente sinalizados e isolados:
 *  - existem SOMENTE em ministérios novos com `is_demo = true` e slug `demo-*`
 *    (os painéis em modo produção filtram `is_demo = false`);
 *  - métricas herdam `is_demo` do ministério (gatilho fill_metric_observation);
 *  - a conta conectada fictícia não tem credenciais, fica com
 *    `sync_enabled = false` (o agendador a ignora) e é reconhecida por
 *    `isDemoAccount` (runJob cancela qualquer job para ela).
 *
 * Por que `systemDb`: é uma semeadura em lote (milhares de linhas, inclusive
 * tabelas sem GRANT de escrita ao papel da aplicação, como external_assets,
 * social_posts e metric_observations). A autorização (superadmin) é validada
 * ANTES, no servidor, e tudo roda em UMA transação.
 */

export const DEMO_SOURCE = "Dados fictícios de demonstração";
const DEMO_SLUG_PREFIX = "demo-";

interface MinistrySeed {
  key: string;
  slug: string;
  name: string;
  color: string;
  description: string;
  prefix: string;
  campaigns: Array<{ name: string; objective: string; status: string; startOffset: number; endOffset: number }>;
  events: Array<{ name: string; dayOffset: number; location: string; status: string }>;
}

const SEEDS: MinistrySeed[] = [
  {
    key: "kids", slug: "demo-atitude-kids", name: "[DEMO] Atitude Kids", color: "#f59e0b", prefix: "KIDS",
    description: "Ministério infantil — dados fictícios para demonstração do portal.",
    campaigns: [
      { name: "Conferência Kids 2026", objective: "Aumentar inscrições para a conferência", status: "active", startOffset: -75, endOffset: 20 },
      { name: "Férias com Propósito", objective: "Divulgar a programação de férias", status: "completed", startOffset: -88, endOffset: -40 },
      { name: "Volta às aulas", objective: "Engajar famílias no novo semestre", status: "planning", startOffset: 15, endOffset: 60 },
    ],
    events: [
      { name: "Acampamento Kids", dayOffset: -45, location: "Sítio Atitude", status: "finished" },
      { name: "Conferência Kids", dayOffset: 18, location: "Templo sede", status: "confirmed" },
      { name: "Culto da Família", dayOffset: -12, location: "Templo sede", status: "finished" },
    ],
  },
  {
    key: "mulheres", slug: "demo-mulheres", name: "[DEMO] Mulheres", color: "#e11d48", prefix: "MULHERES",
    description: "Ministério de mulheres — dados fictícios para demonstração do portal.",
    campaigns: [
      { name: "Encontro de Mulheres 2026", objective: "Lotar o encontro anual", status: "active", startOffset: -60, endOffset: 10 },
      { name: "Série Mulheres que Inspiram", objective: "Crescer o engajamento no Instagram", status: "active", startOffset: -85, endOffset: 30 },
      { name: "Chá de Primavera", objective: "Divulgação do chá beneficente", status: "completed", startOffset: -80, endOffset: -50 },
    ],
    events: [
      { name: "Encontro de Mulheres", dayOffset: 8, location: "Centro de convenções", status: "confirmed" },
      { name: "Chá de Primavera", dayOffset: -52, location: "Salão social", status: "finished" },
      { name: "Noite de Oração", dayOffset: -20, location: "Templo sede", status: "finished" },
    ],
  },
  {
    key: "frontline", slug: "demo-frontline", name: "[DEMO] Frontline", color: "#0ea5e9", prefix: "FRONTLINE",
    description: "Ministério de jovens — dados fictícios para demonstração do portal.",
    campaigns: [
      { name: "Frontline Conference", objective: "Vender ingressos para a conferência", status: "active", startOffset: -70, endOffset: 25 },
      { name: "Culto Jovem às sextas", objective: "Aumentar a presença semanal", status: "active", startOffset: -89, endOffset: 40 },
      { name: "Retiro de Carnaval", objective: "Inscrições do retiro", status: "awaiting_approval", startOffset: 5, endOffset: 70 },
    ],
    events: [
      { name: "Frontline Conference", dayOffset: 22, location: "Arena Atitude", status: "confirmed" },
      { name: "Luau Frontline", dayOffset: -33, location: "Praia do Forte", status: "finished" },
      { name: "Retiro de Carnaval", dayOffset: 75, location: "Acampamento Monte Sião", status: "planned" },
    ],
  },
];

const TASK_NAMES = [
  "Arte para feed", "Roteiro do vídeo de chamada", "Reels de bastidores", "Stories de contagem regressiva", "Landing page de inscrição",
  "E-mail marketing", "Carrossel informativo", "Banner para o telão", "Cartaz impresso", "Revisão de textos", "Fotografia do evento",
  "Edição do aftermovie", "Configurar campanha de anúncios", "Relatório parcial", "Identidade visual", "Mensagem para WhatsApp",
  "Convite digital", "Vídeo depoimento", "Pauta para o culto", "Arte para anúncio",
];
const DELIVERABLE_TYPES = ["arte", "video", "reels", "story", "carrossel", "landing_page", "email", "impresso"] as const;
const DELIVERABLE_STATUSES = ["delivered", "delivered", "approved", "in_review", "changes_requested", "in_production", "in_production", "cancelled"] as const;
const CAPTIONS = [
  "Faltam poucos dias! Garanta sua inscrição.", "Bastidores da preparação ✨", "Que noite incrível! Obrigado a todos que vieram.",
  "Programação completa no link da bio.", "Versículo da semana para você compartilhar.", "Você não pode ficar de fora!",
  "Resumo do último encontro em fotos.", "Contagem regressiva começou!", "Convide alguém para vir com você.", "Inscrições abertas.",
];

/** Gerador pseudoaleatório determinístico (dados estáveis entre cargas). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (iso: string, hour = 12) => new Date(`${iso}T${String(hour).padStart(2, "0")}:00:00-03:00`);

async function insertChunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/** Remove TODOS os dados de demonstração (ministérios demo-* e a conta fictícia). */
async function purgeDemo(trx: Tx): Promise<number> {
  const ministries = await trx.selectFrom("app.ministries").select("id").where("is_demo", "=", true).where("slug", "like", `${DEMO_SLUG_PREFIX}%`).execute();
  const ids = ministries.map((m) => m.id);
  // Conta fictícia primeiro: ativos, campanhas da Meta, publicações e métricas caem em cascata.
  await trx.deleteFrom("app.connected_accounts").where("external_user_id", "=", DEMO_ACCOUNT_EXTERNAL_ID).execute();
  if (ids.length) {
    // tasks.ministry_id é ON DELETE SET NULL: removidas explicitamente para não virarem "não classificadas".
    await trx.deleteFrom("app.tasks").where("ministry_id", "in", ids).execute();
    await trx.deleteFrom("app.metric_observations").where("ministry_id", "in", ids).execute();
    await trx.deleteFrom("app.ministries").where("id", "in", ids).execute();
  }
  return ids.length;
}

export interface DemoSummary {
  ministries: number; campaigns: number; events: number; tasks: number; deliverables: number;
  externalCampaigns: number; posts: number; observations: number;
}

async function seed(trx: Tx, actor: Actor): Promise<DemoSummary> {
  const today = todayIso();
  const summary: DemoSummary = { ministries: 0, campaigns: 0, events: 0, tasks: 0, deliverables: 0, externalCampaigns: 0, posts: 0, observations: 0 };
  const account = await trx.insertInto("app.connected_accounts").values({
    provider: "meta", label: DEMO_ACCOUNT_LABEL, auth_type: "personal_token", status: "connected", credentials_encrypted: null,
    sync_enabled: false, external_user_id: DEMO_ACCOUNT_EXTERNAL_ID, external_user_name: "Demonstração (sem acesso real)",
    last_tested_at: new Date(), last_test_ok: true, last_sync_at: new Date(), last_successful_sync_at: new Date(), created_by: actor.userId,
  }).returning("id").executeTakeFirstOrThrow();
  const channels = await trx.selectFrom("app.channels").select(["id", "key"]).execute();
  const channelId = (key: string) => channels.find((c) => c.key === key)?.id;

  const observations: Array<{
    metric_key: string; source: "meta_ads" | "instagram" | "facebook"; connected_account_id: string; external_asset_id: string; ministry_id: string;
    entity_type: string; entity_id: string; granularity: string; period_start: string; period_end: string; dimension_key: string; value: number; currency: string | null;
  }> = [];

  for (const [mi, s] of SEEDS.entries()) {
    const rand = rng(1000 + mi * 7919);
    const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
    const ministry = await trx.insertInto("app.ministries").values({
      slug: s.slug, name: s.name, color: s.color, description: s.description, is_demo: true, status: "active",
    }).returning("id").executeTakeFirstOrThrow();
    summary.ministries++;

    // Campanhas de comunicação
    const campaigns: Array<{ id: string; start: string; end: string; name: string }> = [];
    for (const c of s.campaigns) {
      const start = addDays(today, c.startOffset);
      const end = addDays(today, c.endOffset);
      const row = await trx.insertInto("app.campaigns").values({
        ministry_id: ministry.id, name: c.name, objective: c.objective, description: `${c.name} — ${DEMO_SOURCE.toLowerCase()}.`,
        target_audience: s.key === "kids" ? "Famílias com crianças de 4 a 11 anos" : s.key === "mulheres" ? "Mulheres da igreja e convidadas" : "Jovens de 15 a 29 anos",
        start_date: start, end_date: end, status: c.status, created_by: actor.userId,
        final_summary: c.status === "completed" ? "Campanha concluída com boa adesão (dados fictícios)." : null,
        learnings: c.status === "completed" ? "Vídeos curtos tiveram melhor desempenho que artes estáticas." : null,
      }).returning("id").executeTakeFirstOrThrow();
      campaigns.push({ id: row.id, start, end, name: c.name });
      const chs = ["instagram", "meta_ads", s.key === "kids" ? "whatsapp" : "facebook", "telao"].map(channelId).filter((v): v is string => Boolean(v));
      if (chs.length) await trx.insertInto("app.campaign_channels").values(chs.map((channel_id) => ({ campaign_id: row.id, channel_id }))).execute();
      summary.campaigns++;
    }

    // Eventos (+ vínculo com campanhas e resultados dos já realizados)
    for (const [ei, e] of s.events.entries()) {
      const day = addDays(today, e.dayOffset);
      const ev = await trx.insertInto("app.events").values({
        ministry_id: ministry.id, name: e.name, starts_at: at(day, 19), ends_at: at(day, 22), location: e.location, status: e.status,
        communication_objective: "Divulgar e mobilizar participantes", promotion_start: addDays(day, -30), promotion_end: day,
        results_summary: e.status === "finished" ? "Evento realizado com público acima do esperado (dados fictícios)." : null,
        results_consolidated_at: e.status === "finished" ? at(addDays(day, 2)) : null, created_by: actor.userId,
      }).returning("id").executeTakeFirstOrThrow();
      summary.events++;
      const campaign = campaigns[ei % campaigns.length]!;
      await trx.insertInto("app.campaign_events").values({ campaign_id: campaign.id, event_id: ev.id }).execute();
      if (e.status === "finished") {
        await trx.insertInto("app.event_results").values([
          { ministry_id: ministry.id, event_id: ev.id, label: "Participantes", value: between(120, 900), unit: "count", source: DEMO_SOURCE, recorded_by: actor.userId },
          { ministry_id: ministry.id, event_id: ev.id, label: "Inscrições online", value: between(60, 400), unit: "count", source: DEMO_SOURCE, recorded_by: actor.userId },
          { ministry_id: ministry.id, event_id: ev.id, label: "Novos visitantes", value: between(5, 80), unit: "count", source: DEMO_SOURCE, recorded_by: actor.userId },
        ]).execute();
      }
    }

    // Demandas manuais: concluídas (espalhadas em 90 dias), atrasadas e em andamento
    const tasks = TASK_NAMES.map((name, ti) => {
      const r = rand();
      const campaign = campaigns[ti % campaigns.length]!;
      if (r < 0.55) {
        const doneDay = addDays(today, -between(1, 89));
        return {
          ministry_id: ministry.id, campaign_id: campaign.id, source: "manual", name, assignee_name: ["Ana", "Bruno", "Carla", "Diego"][ti % 4]!,
          completed: true, completed_at: at(doneDay, between(9, 18)), due_on: addDays(doneDay, between(-3, 4)), start_on: addDays(doneDay, -between(3, 12)),
          created_at_source: at(addDays(doneDay, -between(4, 15))), classification: "manual", classification_reason: DEMO_SOURCE, created_by: actor.userId,
        };
      }
      const overdue = r < 0.72;
      return {
        ministry_id: ministry.id, campaign_id: campaign.id, source: "manual", name, assignee_name: ["Ana", "Bruno", "Carla", "Diego"][ti % 4]!,
        completed: false, completed_at: null, due_on: overdue ? addDays(today, -between(1, 20)) : addDays(today, between(1, 30)),
        start_on: addDays(today, -between(5, 20)), created_at_source: at(addDays(today, -between(10, 40))),
        classification: "manual", classification_reason: DEMO_SOURCE, created_by: actor.userId,
      };
    });
    const taskRows = await trx.insertInto("app.tasks").values(tasks).returning(["id", "campaign_id"]).execute();
    summary.tasks += taskRows.length;

    // Entregáveis em vários status
    const deliverables = Array.from({ length: 10 }, (_, di) => {
      const status = DELIVERABLE_STATUSES[di % DELIVERABLE_STATUSES.length]!;
      const type = DELIVERABLE_TYPES[di % DELIVERABLE_TYPES.length]!;
      const due = addDays(today, between(-40, 25));
      const done = status === "delivered" || status === "approved";
      return {
        ministry_id: ministry.id, campaign_id: campaigns[di % campaigns.length]!.id, task_id: taskRows[di]?.id ?? null,
        title: `${type === "landing_page" ? "Landing page" : type[0]!.toUpperCase() + type.slice(1)} — ${campaigns[di % campaigns.length]!.name}`,
        description: DEMO_SOURCE, type, status, due_date: due,
        delivered_at: status === "delivered" ? at(due < today ? due : addDays(today, -1), 17) : null,
        approved_at: done ? at(due < today ? due : addDays(today, -1), 11) : null, approved_by: done ? actor.userId : null, created_by: actor.userId,
      };
    });
    await trx.insertInto("app.deliverables").values(deliverables).execute();
    summary.deliverables += deliverables.length;

    // Investimentos e metas
    for (const c of campaigns) {
      const planned = between(8, 30) * 100;
      const spentDay = c.start < today ? addDays(c.start, between(2, 10)) : c.start;
      await trx.insertInto("app.investments").values([
        { ministry_id: ministry.id, campaign_id: c.id, kind: "planned", category: "midia_paga", description: "Mídia paga planejada", amount: planned, spent_on: c.start, created_by: actor.userId },
        { ministry_id: ministry.id, campaign_id: c.id, kind: "planned", category: "producao", description: "Produção de vídeo", amount: between(5, 15) * 100, spent_on: c.start, created_by: actor.userId },
        ...(c.start < today ? [
          { ministry_id: ministry.id, campaign_id: c.id, kind: "realized" as const, category: "producao", description: "Produção de vídeo (realizado)", amount: between(4, 14) * 100, spent_on: spentDay < today ? spentDay : today, created_by: actor.userId },
          { ministry_id: ministry.id, campaign_id: c.id, kind: "realized" as const, category: "impressao", description: "Material impresso", amount: between(2, 8) * 100, spent_on: spentDay < today ? spentDay : today, created_by: actor.userId },
        ] : []),
      ]).execute();
      await trx.insertInto("app.campaign_goals").values([
        { ministry_id: ministry.id, campaign_id: c.id, label: "Impressões nos anúncios", metric_key: "impressions", target_value: between(8, 20) * 10_000, unit: "count" },
        { ministry_id: ministry.id, campaign_id: c.id, label: "Inscrições", metric_key: null, target_value: between(2, 6) * 100, unit: "count",
          manual_actual_value: between(100, 450), manual_actual_source: DEMO_SOURCE },
      ]).execute();
    }

    // Ativos fictícios da Meta associados ao ministério
    const assetValues = [
      { asset_type: "meta_ad_account", external_id: `demo-act-${s.key}`, name: `[DEMO] Anúncios ${s.name.replace("[DEMO] ", "")}`, metadata: { currency: "BRL", demo: true } },
      { asset_type: "instagram_account", external_id: `demo-ig-${s.key}`, name: `[DEMO] @${s.key}.atitude`, metadata: { username: `${s.key}.atitude`, demo: true } },
      { asset_type: "facebook_page", external_id: `demo-fb-${s.key}`, name: `[DEMO] Página ${s.name.replace("[DEMO] ", "")}`, metadata: { demo: true } },
    ];
    const assets = await trx.insertInto("app.external_assets").values(assetValues.map((a) => ({
      connected_account_id: account.id, provider: "meta", asset_type: a.asset_type, external_id: a.external_id, name: a.name,
      metadata: JSON.stringify(a.metadata) as unknown as Json, sync_enabled: true, last_synced_at: new Date(),
    }))).returning(["id", "asset_type"]).execute();
    await trx.insertInto("app.asset_ministry_mappings").values(assets.map((a) => ({ external_asset_id: a.id, ministry_id: ministry.id, created_by: actor.userId }))).execute();
    const adAccount = assets.find((a) => a.asset_type === "meta_ad_account")!;
    const ig = assets.find((a) => a.asset_type === "instagram_account")!;
    const fb = assets.find((a) => a.asset_type === "facebook_page")!;
    await trx.insertInto("app.metric_availability").values([
      ...["spend", "impressions", "reach", "clicks", "link_clicks", "results", "video_views"].map((k) => ({ external_asset_id: adAccount.id, metric_key: k, available: true })),
      ...["views", "reach", "likes", "comments", "shares", "saves", "total_interactions", "followers"].map((k) => ({ external_asset_id: ig.id, metric_key: k, available: true })),
      ...["views", "likes", "comments", "shares", "total_interactions", "followers"].map((k) => ({ external_asset_id: fb.id, metric_key: k, available: true })),
      { external_asset_id: fb.id, metric_key: "saves", available: false, reason: "Não fornecido pelo Facebook" },
    ]).execute();

    // Campanhas da Meta (entidades nativas) + métricas diárias de 90 dias
    const metaCampaigns = [
      { campaign: campaigns[0]!, suffix: "Tráfego", objective: "OUTCOME_TRAFFIC", fromDay: -89, toDay: 0, base: between(2500, 5000) },
      { campaign: campaigns[1]!, suffix: "Engajamento", objective: "OUTCOME_ENGAGEMENT", fromDay: -80, toDay: -15, base: between(1500, 3500) },
    ];
    for (const [ci, mc] of metaCampaigns.entries()) {
      const ext = await trx.insertInto("app.external_campaigns").values({
        external_asset_id: adAccount.id, external_id: `demo-cmp-${s.key}-${ci + 1}`, ministry_id: ministry.id,
        name: `${s.prefix} | ${mc.campaign.name} — ${mc.suffix}`, objective: mc.objective, status: mc.toDay === 0 ? "ACTIVE" : "PAUSED",
        effective_status: mc.toDay === 0 ? "ACTIVE" : "PAUSED", start_time: at(addDays(today, mc.fromDay), 8),
        stop_time: mc.toDay === 0 ? null : at(addDays(today, mc.toDay), 23), classification: "auto", classification_reason: DEMO_SOURCE,
      }).returning("id").executeTakeFirstOrThrow();
      summary.externalCampaigns++;
      await trx.insertInto("app.campaign_external_campaigns").values({ campaign_id: mc.campaign.id, external_campaign_id: ext.id, linked_by: actor.userId }).execute();
      for (let d = mc.fromDay; d <= mc.toDay; d++) {
        const day = addDays(today, d);
        const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
        const season = weekday === 0 || weekday === 6 ? 1.25 : 1;
        const trend = 1 + (d - mc.fromDay) / 180;
        const impressions = Math.round(mc.base * season * trend * (0.8 + rand() * 0.4));
        const clicks = Math.round(impressions * (0.009 + rand() * 0.008));
        const linkClicks = Math.round(clicks * (0.6 + rand() * 0.2));
        const spend = Math.round((impressions / 1000) * (14 + rand() * 9) * 100) / 100;
        const values: Array<[string, number, string]> = [
          ["impressions", impressions, ""], ["reach", Math.round(impressions * (0.55 + rand() * 0.15)), ""], ["clicks", clicks, ""],
          ["link_clicks", linkClicks, ""], ["results", linkClicks, "link_click"], ["spend", spend, ""],
          ["video_views", Math.round(impressions * (0.18 + rand() * 0.12)), ""],
        ];
        for (const [metric, value, dimension] of values) {
          observations.push({
            metric_key: metric, source: "meta_ads", connected_account_id: account.id, external_asset_id: adAccount.id, ministry_id: ministry.id,
            entity_type: "meta_campaign", entity_id: ext.id, granularity: "day", period_start: day, period_end: day, dimension_key: dimension,
            value, currency: metric === "spend" ? "BRL" : null,
          });
        }
      }
    }

    // Publicações orgânicas (snapshot acumulado mais recente)
    const posts: Array<{ platform: "instagram" | "facebook"; asset: string; n: number }> = [{ platform: "instagram", asset: ig.id, n: 12 }, { platform: "facebook", asset: fb.id, n: 6 }];
    for (const p of posts) {
      for (let pi = 0; pi < p.n; pi++) {
        const day = addDays(today, -Math.round(((pi + 0.5) / p.n) * 88));
        const video = pi % 3 === 0;
        const post = await trx.insertInto("app.social_posts").values({
          external_asset_id: p.asset, platform: p.platform, external_id: `demo-${p.platform}-${s.key}-${pi + 1}`, ministry_id: ministry.id,
          caption: `[DEMO] ${CAPTIONS[(pi + mi) % CAPTIONS.length]}`, media_type: video ? "VIDEO" : pi % 3 === 1 ? "CAROUSEL_ALBUM" : "IMAGE",
          media_product_type: video && p.platform === "instagram" ? "REELS" : "FEED", permalink: null, published_at: at(day, between(8, 20)),
          classification: "auto", classification_reason: DEMO_SOURCE,
        }).returning("id").executeTakeFirstOrThrow();
        summary.posts++;
        if (pi % 2 === 0) {
          await trx.insertInto("app.campaign_social_posts").values({ campaign_id: campaigns[pi % 2]!.id, social_post_id: post.id, linked_by: actor.userId }).execute();
        }
        const views = between(video ? 2500 : 700, video ? 12_000 : 4500);
        const likes = Math.round(views * (0.04 + rand() * 0.05));
        const comments = Math.round(likes * (0.03 + rand() * 0.07));
        const shares = Math.round(likes * (0.05 + rand() * 0.1));
        const saves = p.platform === "instagram" ? Math.round(likes * (0.04 + rand() * 0.1)) : null;
        const metrics: Array<[string, number | null]> = [
          ["views", views], ["reach", Math.round(views * (0.6 + rand() * 0.2))], ["likes", likes], ["comments", comments], ["shares", shares],
          ["saves", saves], ["total_interactions", likes + comments + shares + (saves ?? 0)],
        ];
        for (const [metric, value] of metrics) {
          if (value == null) continue;
          observations.push({
            metric_key: metric, source: p.platform, connected_account_id: account.id, external_asset_id: p.asset, ministry_id: ministry.id,
            entity_type: "social_post", entity_id: post.id, granularity: "lifetime", period_start: day, period_end: today, dimension_key: "", value, currency: null,
          });
        }
      }
      observations.push({
        metric_key: "followers", source: p.platform, connected_account_id: account.id, external_asset_id: p.asset, ministry_id: ministry.id,
        entity_type: "external_asset", entity_id: p.asset, granularity: "snapshot", period_start: today, period_end: today, dimension_key: "",
        value: between(p.platform === "instagram" ? 3000 : 1500, p.platform === "instagram" ? 15_000 : 6000), currency: null,
      });
    }
  }

  await insertChunked(observations, 500, (chunk) => trx.insertInto("app.metric_observations").values(chunk.map((o) => ({ ...o, api_version: "demo" }))).execute());
  summary.observations = observations.length;
  return summary;
}

function assertSuperadmin(actor: Actor) {
  if (actor.globalRole !== "superadmin") throw new ServiceError("Apenas superadministradores gerenciam dados de demonstração.", "forbidden");
}

/** Carrega (ou recarrega, sem duplicar) os dados de demonstração. */
export async function loadDemoData(actor: Actor, db: Database = systemDb()): Promise<DemoSummary> {
  assertSuperadmin(actor);
  return db.transaction().execute(async (trx) => {
    const removed = await purgeDemo(trx);
    const summary = await seed(trx, actor);
    await auditSystem(trx, actor.userId, {
      entityType: "demo_data", action: "demo_loaded", visibility: "admin",
      summary: `Dados de demonstração carregados (${summary.ministries} ministérios fictícios)`, changes: { ...summary, replacedMinistries: removed },
    });
    return summary;
  });
}

export async function removeDemoData(actor: Actor, db: Database = systemDb()): Promise<{ ministries: number }> {
  assertSuperadmin(actor);
  return db.transaction().execute(async (trx) => {
    const ministries = await purgeDemo(trx);
    await auditSystem(trx, actor.userId, {
      entityType: "demo_data", action: "demo_removed", visibility: "admin", summary: `Dados de demonstração removidos (${ministries} ministérios)`,
    });
    return { ministries };
  });
}

export async function demoStatus(actor: Actor, db: Database = systemDb()): Promise<{ loaded: boolean; ministries: number }> {
  assertSuperadmin(actor);
  const r = await db.selectFrom("app.ministries").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("is_demo", "=", true).where("slug", "like", `${DEMO_SLUG_PREFIX}%`).executeTakeFirstOrThrow();
  return { loaded: Number(r.n) > 0, ministries: Number(r.n) };
}
