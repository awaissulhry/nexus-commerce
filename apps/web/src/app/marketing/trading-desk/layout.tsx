/**
 * Trading Desk shell — the rebuilt advertising hub.
 *
 * Separate from the legacy /marketing/advertising section (which stays live
 * and untouched). Tight 7-item rail + content. Surfaces are migrated in here
 * phase-by-phase; until then their rail items open the existing tool in a new tab.
 */
import type { ReactNode } from 'react'
import { TradingDeskSidebar } from './_shared/TradingDeskSidebar'

export default function TradingDeskLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex">
      <TradingDeskSidebar />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
