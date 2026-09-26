/**
 * F1 — root layout: fonts exactly as Nexus loads them (next/font/google,
 * build-time self-hosted — zero runtime requests, local-first friendly) and
 * the five DS stylesheets loaded GLOBALLY (greenfield privilege; see
 * F0-DESIGN-BRIDGE). Providers: Auth + DS Toast.
 */
import type { Metadata } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";

import "@/design-system/styles/tokens.css";
import "@/design-system/styles/primitives.css";
import "@/design-system/styles/components.css";
import "@/design-system/styles/patterns.css";
import "@/design-system/styles/a11y.css";
import "./globals.css";

import { Providers } from "@/components/Providers";

/* DS fonts (Owner, 2026-09-26: "Arial … must never happen again") — `adjustFontFallback: false` drops next/font's
   metric fallback face, which is local("Arial"): with it, every glyph the loaded subsets lack (→ ≤ ≥ ✓ ↕ …) and all text
   before the font arrived was drawn in Arial. The fallback is now the system UI font. `scripts/check-font-families.mjs`
   holds this. */
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap", adjustFontFallback: false, fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] });
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["400", "500", "600", "700"],
  adjustFontFallback: false,
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600", "700"],
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: "Nexus Factory OS",
  description: "Local-first factory platform — from the email an order is born in to the review it ends with.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
