import Link from "next/link";
import { SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-surface-muted text-subtle ring-1 ring-border"><SearchX className="size-5" aria-hidden /></div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Página não encontrada</h1>
      <p className="mt-1 max-w-md text-sm text-subtle">O conteúdo não existe ou você não tem permissão para acessá-lo.</p>
      <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-contrast">Voltar ao início</Link>
    </div>
  );
}
