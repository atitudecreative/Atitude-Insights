import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getActor } from "@/server/auth/current";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getActor()) redirect("/");
  const { next } = await searchParams;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
      <p className="mt-1 mb-6 text-sm text-subtle">Use o e-mail e a senha definidos no seu convite.</p>
      <LoginForm next={next} />
      <p className="mt-6 text-xs text-subtle">Esqueceu a senha? Peça a um administrador um link de redefinição.</p>
    </div>
  );
}
