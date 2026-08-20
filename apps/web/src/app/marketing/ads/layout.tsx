/** New ads console (Adtomic-match) — isolated at /marketing/ads; standalone via AppShell. */
// W6 (2026-08-20) — the DS token + primitive sheets load tree-wide, BEFORE ads.css, so the
// promoted InfoTip's `.h10-tip` styles (now in primitives.css) reach every ads page exactly as
// they did when ads.css carried them — and page styles keep the last word (source order).
// primitives.css is fully `.h10-ds-*`-namespaced (checked before this import), so pages that
// never opted into the DS sheets are visually untouched by this.
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import './ads.css'
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
