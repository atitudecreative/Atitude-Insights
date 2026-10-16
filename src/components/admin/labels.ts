import type { Tone } from "@/lib/labels";

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Ativo", tone: "success" },
  disabled: { label: "Desativado", tone: "danger" },
  invited: { label: "Convidado", tone: "warning" },
};

export const INVITE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pendente", tone: "warning" },
  accepted: { label: "Aceito", tone: "success" },
  expired: { label: "Expirado", tone: "muted" },
  revoked: { label: "Revogado", tone: "muted" },
};

export const LOG_LEVEL: Record<string, { label: string; tone: Tone }> = {
  debug: { label: "Debug", tone: "muted" },
  info: { label: "Info", tone: "info" },
  warn: { label: "Aviso", tone: "warning" },
  error: { label: "Erro", tone: "danger" },
};

export const SYNC_TRIGGER: Record<string, string> = {
  manual: "Manual", schedule: "Agendada", retry: "Reexecução", system: "Sistema",
};
