import type { Metadata } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// P0 — Inter (variable) as the app body font, exposed as --font-sans.
// `display: swap` keeps text visible during load; Inter is metrically
// close to the old system stack so there's no layout shift.
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans",
  display: "swap",
});

// P0-FC — Space Grotesk (geometric display) for headings + hero
// numerals, and JetBrains Mono for tabular data/metrics. The
// "command-center" type pairing of the futuristic console language.
// Exposed as --font-display / --font-mono (tailwind fontFamily.display
// / .mono). Loaded globally but only applied via the display/mono
// utility classes, so body text stays Inter.
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
import { AppNavRail } from "@/app/_shared/AppNavRail";
import AppShell from "@/components/layout/AppShell";
import CommandPalette from "@/components/CommandPalette";
import CommandMatrixPanel from "@/components/CommandMatrixPanel";
import NotificationsBell from "@/components/NotificationsBell";
import MobileTopBar from "@/components/MobileTopBar";
import { GlobalDlqBanner } from "@/components/dashboard/GlobalDlqBanner";
import { GlobalAccountHealthBanner } from "@/components/dashboard/GlobalAccountHealthBanner";
import { CompetitiveAlertWatcher } from "@/components/dashboard/CompetitiveAlertWatcher";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { AuthProvider } from "@/lib/auth/AuthProvider";
import { PageGuard } from "@/lib/auth/PageGuard";
import CopilotMount from "@/components/CopilotMount";
import { getServerLocale, getServerT } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "Nexus Commerce",
  description: "Master catalog and multi-channel listing platform",
};

// PERF (Phase 1) — pin SSR functions to Frankfurt (EU), co-located with the
// Railway API + DB in europe-west4. Default was US-East (iad1), so every server
// render did a transatlantic round trip to the API on each fetch. Operators are
// EU-based, so this speeds up the whole app, not just advertising. Cascades to
// all nested routes.
export const preferredRegion = "fra1";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // W5.13 — Read locale from the cookie that use-translations.ts
  // mirrors on every setLocale() call. Used for the html `lang`
  // attribute (screen readers use it for pronunciation + voice
  // selection — hardcoded "en" was wrong for Italian operators)
  // and for the skip-link text.
  const locale = await getServerLocale();
  const t = await getServerT();
  return (
    <html lang={locale} className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>
        {/* U.13 — skip-to-content link (WCAG 2.4.1 Bypass Blocks).
            Visually hidden until keyboard-focused, then anchors at
            the top of the viewport so screen-reader/keyboard users
            can jump past the sidebar nav on every page load. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-blue-600 focus:text-white focus:px-3 focus:py-2 focus:rounded focus:shadow-lg focus:font-medium"
        >
          {t('a11y.skipToContent')}
        </a>
        <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            {/* AppShell renders the full Nexus chrome for normal routes and a
                bare full-screen surface for standalone routes (Trading Desk).
                Slots are server components rendered identically to before. */}
            <AppShell
              sidebar={<AppNavRail />}
              topBar={<MobileTopBar />}
              banners={
                <>
                  {/* RT.16 — account-health banner FIRST (top of stack). */}
                  <GlobalAccountHealthBanner />
                  {/* RT.2 — global DLQ alert (hidden when depth=0). */}
                  <GlobalDlqBanner />
                </>
              }
              overlays={
                <>
                  <CommandPalette />
                  <CommandMatrixPanel />
                  <NotificationsBell />
                  {/* RT.13 — Buy Box loss alert listener (no visual UI). */}
                  <CompetitiveAlertWatcher />
                </>
              }
            >
              <PageGuard>{children}</PageGuard>
            </AppShell>
            {/* ACP.7b — page-aware copilot on EVERY route (incl. standalone
                surfaces); excludes public customer pages. One mount, no
                per-page edits. */}
            <CopilotMount />
          </ConfirmProvider>
        </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
