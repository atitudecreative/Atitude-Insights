import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { contrastText, getBranding } from "@/server/services/settings";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBranding();
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: `Portal de inteligência, campanhas e prestação de contas — ${brand.organization}`,
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f6f7fb" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const brand = await getBranding();
  // A cor da marca vem de configuração validada (regex hexadecimal).
  const brandCss = `:root{--brand:${brand.primaryColor};--brand-contrast:${contrastText(brand.primaryColor)}}`;
  return (
    <html lang="pt-BR" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <style>{brandCss}</style>
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
