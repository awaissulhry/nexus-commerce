'use client'

/**
 * AppShell — decides how much Nexus chrome a route renders.
 *
 * Until TB.1 this was a binary: full chrome (rail + banners + overlays), or a bare full-screen
 * surface with none of it. That binary is what made `⌘K` dead on `/products/next`: the rail's
 * search button dispatches `nexus:open-command-palette`, the only listener is `CommandPalette`,
 * and `CommandPalette` mounts in the `overlays` slot the standalone branch never rendered.
 *
 * There are now THREE levels, because the two reasons a route went "standalone" were never the
 * same reason:
 *
 *   1. full chrome        — the app's own routes.
 *   2. NO_RAIL_PREFIXES   — the route brings its OWN shell and rail (the ads cockpit's
 *                           `AdsSidebar`, `/products/next`'s `ProductsRail`). It never wanted the
 *                           app rail; it does want the top bar.
 *   3. NO_CHROME_PREFIXES — the route must show nothing about us AT ALL.
 *
 * 🔴 Level 3 is a privacy boundary, not a styling choice. `/shared` renders a report for someone
 * with NO account (RPT.15: "no sidebar, no command palette, no banners: they see one table and
 * nothing else about us"). An account switcher and a notifications feed on that page would leak
 * the operator's account roster to an outside recipient. Auth routes are here for the simpler
 * reason that no session exists yet. Do not move a prefix from level 3 to level 2.
 */

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
// Rail styles (.h10-rail / .h10-item / .h10-sub* / chrome). These used to come from
// ads.css, which meant every non-standalone route pulled in the whole ads cockpit —
// 3,089 lines — to style a rail. They now live in _shared/shared-shell.css, split
// verbatim out of ads.css and verified rule-by-rule as order-preserving.
// Closes TODO(P7).
import '@/app/_shared/shared-shell.css'
import '@/app/_shared/app-topbar.css'
import { AppTopBar } from '@/app/_shared/AppTopBar'

/**
 * Routes that bring their own shell and rail, and so render the top bar but not the app rail.
 *
 * These are the deliberately-light shells (operator decision 2026-08-05, "no dark mode here").
 * That still governs their CONTENT. It no longer governs the chrome: since 2026-08-31 the bar
 * and rail are one dark surface on every route, so this list no longer needs to mark them.
 */
const NO_RAIL_PREFIXES = ['/marketing/ads-console', '/marketing/ads', '/products/next']

/** Routes that render NO Nexus chrome whatsoever. See the privacy note above. */
const NO_CHROME_PREFIXES = [
  '/shared',
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
  const noChrome = NO_CHROME_PREFIXES.some((p) => pathname.startsWith(p))
  const noRail = NO_RAIL_PREFIXES.some((p) => pathname.startsWith(p))

  if (noChrome) {
    // Full-bleed: no bar, no rail, no banners, no command palette. Byte-identical to the
    // pre-TB.1 standalone branch — `--nds-chrome-top` is never set, so its 0px fallback keeps
    // every shell at its original height.
    return (
      <main id="main-content" tabIndex={-1} className="h-[100dvh] overflow-hidden">
        {children}
      </main>
    )
  }

  if (noRail) {
    // The route's own layout renders `.h10-shell`, which subtracts `--nds-chrome-top` from its
    // height — so its rail lands below the bar without `.h10-rail` itself being touched (that
    // class is shared with the ads cockpit's own `<aside>`).
    return (
      <>
        <div className="nds-chrome-host">
          <AppTopBar />
          <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 overflow-hidden">
            {children}
          </main>
        </div>
        <div data-print-hide>{overlays}</div>
      </>
    )
  }

  return (
    <>
      <div className="nds-chrome-host">
        <AppTopBar />
        {/* Rail model: the container is the positioning context and reserves the
            collapsed rail width via padding-left; the rail (rendered by `sidebar`
            as an absolutely-positioned .h10-rail at left:0) overlays that strip and
            hover-expands without shifting content. `--rail-reserve` lets a pinned
            rail reserve the expanded width (added with the pin follow-up); it
            defaults to the collapsed width.

            TB.1 — the height is now the viewport MINUS the bar, so the rail's own
            `top: 0; height: 100%` puts it directly under the bar with no change to
            `.h10-rail`. The rail therefore slides UNDER the bar when it hover-expands
            to 344px, which is why the bar is full-width rather than inset. */}
        <div
          className="app-rail-host relative flex flex-1 min-h-0 bg-slate-50 dark:bg-slate-950 overflow-hidden"
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
      </div>
      <div data-print-hide>{overlays}</div>
    </>
  )
}
