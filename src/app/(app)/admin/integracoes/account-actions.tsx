import { ActionButton } from "@/components/admin/action-button";
import { disconnectAction, runSyncAction, testConnectionAction } from "../actions";

/** Botões de operação de uma conta conectada (Server Actions; nenhum token vai ao navegador). */
export function AccountActions({ accountId, provider, disabled, isDemo, compact }: {
  accountId: string; provider: string; disabled?: boolean; isDemo?: boolean; compact?: boolean;
}) {
  if (isDemo) return <p className="text-xs text-subtle">Conta fictícia de demonstração: não testa nem sincroniza.</p>;
  if (disabled) return <p className="text-xs text-subtle">Conta desconectada. Conecte novamente para retomar a sincronização.</p>;
  const hidden = { accountId };
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ActionButton action={testConnectionAction} hidden={hidden} label="Testar conexão" pendingLabel="Testando…" />
      <ActionButton action={runSyncAction} hidden={{ ...hidden, kind: "sync" }} label="Sincronizar agora" pendingLabel="Sincronizando…" variant="primary" />
      <ActionButton action={runSyncAction} hidden={{ ...hidden, kind: "discover" }} label="Descobrir ativos" pendingLabel="Descobrindo…" />
      {!compact ? (
        <ActionButton action={runSyncAction} hidden={{ ...hidden, kind: "reclassify" }} label="Reclassificar" pendingLabel="Reclassificando…"
          confirm={provider === "asana" ? "Executar uma sincronização completa do Asana para reaplicar as regras a todas as demandas (classificações manuais são preservadas)?" : "Ressincronizar campanhas e publicações da Meta para reaplicar as regras (classificações manuais são preservadas)?"} />
      ) : null}
      <ActionButton action={disconnectAction} hidden={hidden} label="Desconectar" variant="danger-ghost"
        confirm="Desconectar esta conta? A credencial cifrada será apagada e a sincronização interrompida. Os dados já importados são mantidos." />
    </div>
  );
}
