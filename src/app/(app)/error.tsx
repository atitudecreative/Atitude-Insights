"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Erro inesperado: mensagem segura, sem detalhes internos. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-4 text-center" role="alert">
      <div className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger"><AlertTriangle className="size-5" aria-hidden /></div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Não foi possível carregar esta página</h1>
      <p className="mt-1 max-w-md text-sm text-subtle">Tente novamente. Se o problema continuar, informe o código abaixo ao administrador.</p>
      {error.digest ? <code className="mt-3 rounded bg-surface-muted px-2 py-1 text-xs text-muted">{error.digest}</code> : null}
      <Button className="mt-6" onClick={reset}>Tentar novamente</Button>
    </div>
  );
}
