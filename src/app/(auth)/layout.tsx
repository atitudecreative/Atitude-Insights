import type { ReactNode } from "react";
import { BrandMark } from "@/components/layout/brand-mark";
import { getBranding } from "@/server/services/settings";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const brand = await getBranding();
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-brand lg:block">
        <div aria-hidden className="absolute inset-0 opacity-[0.14]" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, white 0, transparent 40%), radial-gradient(circle at 80% 70%, white 0, transparent 35%)" }} />
        <div className="relative flex h-full flex-col justify-between p-12 text-brand-contrast">
          <BrandMark name={brand.name} logoUrl={brand.logoUrl} className="[&>span:first-child]:bg-white/15" />
          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-tight tracking-tight">
              O trabalho da comunicação, os investimentos e os resultados de cada ministério — em um só lugar.
            </p>
            <p className="mt-4 text-sm opacity-80">{brand.organization}</p>
          </div>
          <p className="text-xs opacity-70">Acesso restrito a usuários convidados.</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><BrandMark name={brand.name} logoUrl={brand.logoUrl} /></div>
          {children}
        </div>
      </div>
    </main>
  );
}
