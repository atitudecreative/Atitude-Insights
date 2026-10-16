import type { Metadata } from "next";
import Link from "next/link";
import { getInvitationByToken } from "@/server/auth/service";
import { systemDb } from "@/server/db";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Convite", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await getInvitationByToken(systemDb(), token);
  const valid = inv && !inv.accepted_at && !inv.revoked_at && new Date(inv.expires_at) > new Date();
  if (!valid) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Link inválido ou expirado</h1>
        <p className="mt-2 text-sm text-subtle">Este link já foi utilizado, foi revogado ou expirou. Solicite um novo ao administrador.</p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand">Ir para o login</Link>
      </div>
    );
  }
  const reset = inv.kind === "password_reset";
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{reset ? "Redefinir senha" : `Bem-vindo(a), ${inv.name.split(" ")[0]}`}</h1>
      <p className="mt-1 mb-6 text-sm text-subtle">
        {reset ? "Defina uma nova senha. Sessões anteriores serão encerradas." : `Você foi convidado(a)${inv.ministry_name ? ` para acompanhar ${inv.ministry_name}` : ""}. Defina sua senha para acessar.`}
      </p>
      <AcceptForm token={token} email={inv.email} />
    </div>
  );
}
