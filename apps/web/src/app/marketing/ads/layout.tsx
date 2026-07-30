/** New ads console (Adtomic-match) — isolated at /marketing/ads; standalone via AppShell. */
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
