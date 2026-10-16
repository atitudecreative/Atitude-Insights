export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand" | "muted";

interface StatusDef { label: string; tone: Tone }

export const CAMPAIGN_STATUS: Record<string, StatusDef> = {
  planning: { label: "Planejamento", tone: "neutral" },
  production: { label: "Em produção", tone: "info" },
  awaiting_approval: { label: "Aguardando aprovação", tone: "warning" },
  scheduled: { label: "Agendada", tone: "brand" },
  active: { label: "Em andamento", tone: "success" },
  completed: { label: "Concluída", tone: "muted" },
  archived: { label: "Arquivada", tone: "muted" },
};

export const EVENT_STATUS: Record<string, StatusDef> = {
  planned: { label: "Planejado", tone: "neutral" },
  confirmed: { label: "Confirmado", tone: "brand" },
  finished: { label: "Realizado", tone: "muted" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

export const DELIVERABLE_STATUS: Record<string, StatusDef> = {
  in_production: { label: "Em produção", tone: "info" },
  in_review: { label: "Em revisão", tone: "warning" },
  changes_requested: { label: "Ajustes solicitados", tone: "danger" },
  approved: { label: "Aprovado", tone: "success" },
  delivered: { label: "Entregue", tone: "brand" },
  cancelled: { label: "Cancelado", tone: "muted" },
};

export const DELIVERABLE_TYPE: Record<string, string> = {
  arte: "Arte", video: "Vídeo", reels: "Reels", story: "Story", carrossel: "Carrossel", landing_page: "Landing page",
  email: "E-mail", impresso: "Impresso", identidade_visual: "Identidade visual", fotografia: "Fotografia",
  texto: "Texto", anuncio: "Anúncio", outro: "Outro",
};

export const TASK_STATUS: Record<string, StatusDef> = {
  completed: { label: "Concluída", tone: "success" },
  overdue: { label: "Atrasada", tone: "danger" },
  open: { label: "Em andamento", tone: "info" },
  removed: { label: "Removida na origem", tone: "muted" },
};

export function taskStatus(t: { completed: boolean; due_on: string | null; removed_in_source_at?: Date | string | null }, today: string): keyof typeof TASK_STATUS {
  if (t.removed_in_source_at) return "removed";
  if (t.completed) return "completed";
  if (t.due_on && t.due_on < today) return "overdue";
  return "open";
}

export const INTEGRATION_STATUS: Record<string, StatusDef> = {
  not_configured: { label: "Não configurada", tone: "muted" },
  pending: { label: "Aguardando autorização", tone: "warning" },
  connected: { label: "Conectada", tone: "success" },
  syncing: { label: "Sincronizando", tone: "info" },
  error: { label: "Com erro", tone: "danger" },
  expired: { label: "Credencial expirada", tone: "danger" },
  revoked: { label: "Acesso revogado", tone: "danger" },
  disconnected: { label: "Desconectada", tone: "muted" },
};

export const SYNC_JOB_STATUS: Record<string, StatusDef> = {
  queued: { label: "Na fila", tone: "neutral" },
  running: { label: "Executando", tone: "info" },
  succeeded: { label: "Concluída", tone: "success" },
  partial: { label: "Parcial", tone: "warning" },
  failed: { label: "Falhou", tone: "danger" },
  cancelled: { label: "Cancelada", tone: "muted" },
};

export const SYNC_JOB_TYPE: Record<string, string> = {
  asana_discover: "Asana — descobrir projetos",
  asana_incremental: "Asana — incremental",
  asana_full: "Asana — completa (reconciliação)",
  meta_discover: "Meta — descobrir ativos",
  meta_ads: "Meta Ads — campanhas e métricas",
  meta_organic: "Meta orgânico — publicações e métricas",
};

export const ASSET_TYPE: Record<string, string> = {
  asana_workspace: "Workspace do Asana",
  asana_project: "Projeto do Asana",
  meta_ad_account: "Conta de anúncios",
  facebook_page: "Página do Facebook",
  instagram_account: "Conta do Instagram",
};

export const SOURCE_LABEL: Record<string, string> = {
  meta_ads: "Meta Ads (pago)",
  instagram: "Instagram (orgânico)",
  facebook: "Facebook (orgânico)",
  manual: "Registro manual",
  asana: "Asana",
};

export const INVESTMENT_CATEGORY: Record<string, string> = {
  midia_paga: "Mídia paga", producao: "Produção", impressao: "Impressão", impulsionamento: "Impulsionamento",
  ferramentas: "Ferramentas", outro: "Outro",
};

export const CLASSIFICATION_LABEL: Record<string, StatusDef> = {
  auto: { label: "Automática", tone: "info" },
  manual: { label: "Manual", tone: "brand" },
  unclassified: { label: "Não classificada", tone: "warning" },
};

export const REPORT_SCOPE: Record<string, string> = {
  ministry: "Ministério", campaign: "Campanha", event: "Evento", agency: "Consolidado da agência",
};
