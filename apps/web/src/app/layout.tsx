import type { Metadata } from "next";
import "./globals.css";
import AppSidebar from "@/components/layout/AppSidebar";
import CommandPalette from "@/components/CommandPalette";
import NotificationsBell from "@/components/NotificationsBell";
import MobileTopBar from "@/components/MobileTopBar";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { getServerLocale, getServerT } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "Nexus Commerce",
  description: "Master catalog and multi-channel listing platform",
};

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
    <html lang={locale}>
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
        <ToastProvider>
          <ConfirmProvider>
            <div className="flex h-[100dvh] bg-slate-50 dark:bg-slate-950 overflow-hidden">
              <AppSidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                <MobileTopBar />
                <main
                  id="main-content"
                  className="flex-1 overflow-auto"
                  tabIndex={-1}
                >
                  <div className="p-3 md:p-6">{children}</div>
                </main>
              </div>
            </div>
            <CommandPalette />
            <NotificationsBell />
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
