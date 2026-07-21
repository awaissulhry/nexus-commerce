/**
 * SCG.2 — full Sync Control history (opens in a new tab from the History
 * card). Server-paginated over the complete SyncControlAudit trail.
 */

import PageHeader from '@/components/layout/PageHeader'
import HistoryClient from './HistoryClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SyncControlHistoryPage() {
  return (
    <div>
      <PageHeader
        title="Sync Control — History"
        subtitle="Every control change: who, what, before → after"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Sync Control', href: '/fulfillment/stock/sync-control' },
          { label: 'History' },
        ]}
      />
      <HistoryClient />
    </div>
  )
}
