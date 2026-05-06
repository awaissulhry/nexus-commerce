// /catalog/organize shell. Three-tab catalog organization workspace
// (Suggested Groups · Standalone Products · Parents) backed by the
// existing /api/amazon/pim/* endpoints + /api/pim/* endpoints.
// Renamed from /pim/review on 2026-05-06; the old path 301s here via
// next.config.js redirects().

import OrganizeClient from './OrganizeClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function CatalogOrganizePage() {
  return <OrganizeClient />
}
