/**
 * /products/next — standalone shell layout.
 *
 * AppShell suppresses global chrome for this route (STANDALONE_PREFIXES).
 * This layout provides:
 *   • The shared h10-shell + h10-main structure (from ads.css).
 *   • The AppRail with the full app nav (hover-expand, pure-CSS).
 *   • A light-pin wrapper class so the page renders white/light regardless
 *     of the user's dark-mode preference or any ancestor .dark class.
 *
 * TODO: ads.css contains ads-specific rules mixed with the neutral shell rules
 * (.h10-shell, .h10-rail*, .h10-brand, .h10-nav, .h10-item, .h10-sub, .h10-railft).
 * Those neutral rules should eventually move into a shared-shell.css that both
 * /marketing/ads and /products/next import. Until then, importing ads.css here is
 * the zero-duplication path — the ads-specific rules are scoped classes that don't
 * affect anything outside the ads cockpit.
 */

// Shared rail + layout CSS (same classes as the ads console; see TODO above).
import '../../marketing/ads/ads.css'
// Light pin — re-scopes DS semantic tokens to :root light values under .productsNextLight.
import './products-next-shell.css'

import type { ReactNode } from 'react'
import { AppRail } from '@/app/_shared/AppRail'
import { PRODUCTS_NAV } from './_shell/nav'

export default function ProductsNextLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h10-shell productsNextLight">
      <AppRail
        navItems={PRODUCTS_NAV}
        brand={{ mark: 'N', name: 'Nexus' }}
        footer="Products · rebuild"
      />
      <main className="h10-main">{children}</main>
    </div>
  )
}
