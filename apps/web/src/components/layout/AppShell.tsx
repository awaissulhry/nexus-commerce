'use client'

/**
 * AppShell — decides whether a route renders inside the Nexus app chrome
 * (sidebar + top bar + global banners/overlays) or as a STANDALONE
 * full-screen surface with none of it.
 *
 * The advertising rebuild ("Trading Desk") is a standalone surface: it has
 * its own dark rail and design language and must NOT show the Nexus sidebar.
 * Because a child route cannot remove a parent layout, that decision lives
 * here in the root layout. Server components (AppSidebar, banners, …) are
 * passed in as already-rendered slots, so this client component just places
 * them — non-standalone routes render byte-identically to before.
 */

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
// Rail styles (.h10-rail / .h10-item / .h10-sub* / chrome) live in ads.css.
// Import here so the app-wide rail is styled on every non-standalone route.
// ads.css is fully class-scoped (.h10-*), so this adds no global rules.
// TODO(P7): extract the rail rules into a dedicated _shared/rail.css.
import '../../app/marketing/ads/ads.css'

/** Route prefixes that render with NO Nexus chrome (full-screen). */
const STANDALONE_PREFIXES = [
  '/marketing/ads-console',
  '/marketing/ads',
  '/products/next',
  // Phase S3 — auth surfaces render full-screen, no app chrome.
  '/login',
  '/403',
  '/accept-invite',
  '/reset-password',
  '/forgot-password',
]

export default function AppShell({
  sidebar,
  topBar,
  banners,
  overlays,
  children,
}: {
  sidebar: ReactNode
  topBar: ReactNode
  banners: ReactNode
  overlays: ReactNode
  children: ReactNode
}) {
  const pathname = usePathname() || ''
  const standalone = STANDALONE_PREFIXES.some((p) => pathname.startsWith(p))

  if (standalone) {
    // Full-bleed: no sidebar, no top bar, no banners, no command palette.
    return (
      <main id="main-content" tabIndex={-1} className="h-[100dvh] overflow-hidden">
        {children}
      </main>
    )
  }

  return (
    <>
      {/* Rail model: the container is the positioning context and reserves the
          collapsed rail width via padding-left; the rail (rendered by `sidebar`
          as an absolutely-positioned .h10-rail at left:0) overlays that strip and
          hover-expands without shifting content. `--rail-reserve` lets a pinned
          rail reserve the expanded width (added with the pin follow-up); it
          defaults to the collapsed width. */}
      <div
        className="app-rail-host relative flex h-[100dvh] bg-slate-50 dark:bg-slate-950 overflow-hidden"
        style={{ paddingLeft: 'var(--rail-reserve, 66px)' }}
      >
        {sidebar}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div data-print-hide>{topBar}</div>
          <main id="main-content" className="flex-1 overflow-auto" tabIndex={-1}>
            <div data-print-hide>{banners}</div>
            <div className="p-3 md:p-6">{children}</div>
          </main>
        </div>
      </div>
      <div data-print-hide>{overlays}</div>
    </>
  )
}
