/**
 * Marcador da conta conectada FICTÍCIA criada pelos dados de demonstração
 * (`src/server/services/demo.ts`). A conta não tem credenciais, fica com
 * `sync_enabled = false` (o agendador a ignora) e qualquer job enfileirado
 * para ela é cancelado por `runJob`.
 */
export const DEMO_ACCOUNT_EXTERNAL_ID = "atitude-demo";
export const DEMO_ACCOUNT_LABEL = "[DEMO] Conta fictícia";

export function isDemoAccount(account: { external_user_id?: string | null }): boolean {
  return account.external_user_id === DEMO_ACCOUNT_EXTERNAL_ID;
}
