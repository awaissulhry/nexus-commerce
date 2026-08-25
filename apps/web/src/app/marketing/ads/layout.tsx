/** New ads console (Adtomic-match) — isolated at /marketing/ads; standalone via AppShell. */
// W6 (2026-08-20) — the DS token + primitive sheets load tree-wide, BEFORE ads.css, so the
// promoted InfoTip's `.h10-tip` styles (now in primitives.css) reach every ads page exactly as
// they did when ads.css carried them — and page styles keep the last word (source order).
// primitives.css is fully `.nds-*`-namespaced (checked before this import), so pages that
// never opted into the DS sheets are visually untouched by this.
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
// The neutral shell (rail/brand/nav/user/main) used to open ads.css; it now lives in
// _shared/shared-shell.css so /products/next can have it without the cockpit. It must load
// BEFORE ads.css — the position it held inside it — because this codebase resolves
// conflicts by source order.
import '@/app/_shared/shared-shell.css'
import './ads.css'
// WG.2d — the grid's 146 rules, lifted out of ads.css. MUST load after it: verified in that
// exact position (0 computed-property differences, 0 differing subpixels).
import './campaigns/_grid/workspace-grid.css'
import type { ReactNode } from 'react'
import { AdsSidebar } from './_shell/AdsSidebar'
import { AdsMarketplaceProvider } from './_shell/MarketplaceContext'

export default function AdsLayout({ children }: { children: ReactNode }) {
  return (
    // APS.2a — the marketplace lives at the layout so it survives navigation
    // between builders and pages, and so there is exactly one answer to
    // "which market am I in" for the whole console.
    <AdsMarketplaceProvider>
      <div className="h10-shell">
        <AdsSidebar />
        <main className="h10-main">{children}</main>
      </div>
    </AdsMarketplaceProvider>
  )
}
