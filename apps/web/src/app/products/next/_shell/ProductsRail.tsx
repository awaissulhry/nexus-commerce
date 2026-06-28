'use client'

/**
 * Client wrapper that owns the products nav and renders the shared AppRail.
 *
 * The nav items carry lucide `Icon` *components* (functions), which cannot be
 * passed from a Server Component (the layout) to a Client Component (AppRail)
 * — Next.js forbids non-serializable props across that boundary. Importing the
 * nav inside this client component keeps the icons entirely client-side, the
 * same way the ads cockpit's AdsSidebar owns ADS_NAV.
 */

import { AppRail } from '@/app/_shared/AppRail'
import { PRODUCTS_NAV } from './nav'

export function ProductsRail() {
  return (
    <AppRail
      navItems={PRODUCTS_NAV}
      brand={{ mark: 'N', name: 'Nexus' }}
      footer="Products · rebuild"
    />
  )
}
