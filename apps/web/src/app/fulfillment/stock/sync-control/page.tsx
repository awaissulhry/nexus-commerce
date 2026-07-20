/**
 * SC.2 — /fulfillment/stock/sync-control
 *
 * Read-only Sync Control surface: which listings follow the pool, which are
 * pinned/paused/FBA-excluded, how locations route, active policies, history.
 * Mutations arrive in SC.3; this page must first prove it tells the truth.
 */

import PageHeader from '@/components/layout/PageHeader'
import SyncControlClient from './SyncControlClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SyncControlPage() {
  return (
    <div>
      <PageHeader
        title="Sync Control"
        subtitle="What syncs where — modes, routing, policies and history"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Sync Control' },
        ]}
      />
      <SyncControlClient />
    </div>
  )
}
