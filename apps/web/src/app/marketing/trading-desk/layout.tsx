/**
 * Trading Desk shell — STANDALONE (no Nexus app chrome; see AppShell in the
 * root layout, which renders this route full-screen). Light content canvas +
 * dark navy rail, exactly like the approved spike. Scoped styles in
 * ./trading-desk.css (everything under .td-root, so nothing leaks app-wide).
 */
import './trading-desk.css'
import type { ReactNode } from 'react'
import { TradingDeskSidebar } from './_shared/TradingDeskSidebar'

export default function TradingDeskLayout({ children }: { children: ReactNode }) {
  return (
    <div className="td-root">
      <TradingDeskSidebar />
      <div className="main">{children}</div>
    </div>
  )
}
