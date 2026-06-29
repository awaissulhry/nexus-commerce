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

import { AppNavRail } from '@/app/_shared/AppNavRail'

/**
 * Preview bed for the app-wide rail. ProductsRail now renders the full-featured
 * AppNavRail (live counts + connections + canonical nav) so the rail can be
 * verified in isolation at /products/next before it replaces AppSidebar
 * app-wide in Phase 5.
 */
export function ProductsRail() {
  return <AppNavRail />
}
