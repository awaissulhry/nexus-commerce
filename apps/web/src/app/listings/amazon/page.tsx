// S.5 — Path B Amazon deep view. Replaces the prior thin
// `<ListingsWorkspace lockChannel="AMAZON" />` wrapper with a
// dedicated client that adds marketplace tabs, KPI strip, and
// suppression resolver above the standard workspace.

import AmazonListingsClient from './AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AmazonListingsPage() {
  return (
    <AmazonListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Amazon' }]}
    />
  )
}
