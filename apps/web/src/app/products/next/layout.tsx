/**
 * Product list shell, shared by the canonical /products page and its legacy entry.
 *
 * AppShell supplies the top bar and suppresses its rail for the product list.
 * This layout provides:
 *   • The shared h10-shell + h10-main structure (from ads.css).
 *   • The AppRail with the full app nav (hover-expand, pure-CSS).
 *   • A semantic theme wrapper that follows the operator’s light/dark preference.
 *
 * The shell CSS is `_shared/shared-shell.css` — the neutral rail/brand/nav/user/main
 * rules, split verbatim out of ads.css so this route no longer imports the entire
 * ads cockpit to get a rail. The set was derived from the classes AppRail/AppNavRail
 * actually emit, and the split was verified rule-by-rule as order-preserving.
 */

// Shared rail + layout CSS (the same rules the ads console loads, minus its cockpit).
import '@/app/_shared/shared-shell.css'



import type { ReactNode } from 'react'
import { ProductsRail } from './_shell/ProductsRail'

export default function ProductsNextLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h10-shell nds-theme-responsive">
      <ProductsRail />
      <div className="h10-main">{children}</div>
    </div>
  )
}
