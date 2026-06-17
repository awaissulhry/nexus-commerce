/** New ads console (Adtomic-match) — isolated at /marketing/ads; standalone via AppShell. */
import './ads.css'
import type { ReactNode } from 'react'
import { AdsSidebar } from './_shell/AdsSidebar'

export default function AdsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h10-shell">
      <AdsSidebar />
      <main className="h10-main">{children}</main>
    </div>
  )
}
