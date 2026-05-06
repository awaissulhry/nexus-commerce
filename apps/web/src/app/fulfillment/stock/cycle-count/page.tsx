import PageHeader from '@/components/layout/PageHeader'
import CycleCountListClient from './CycleCountListClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Cycle count list — operator-facing surface for physical inventory
 * count sessions. Click a session to enter the count workspace.
 */
export default function CycleCountPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Cycle Counts"
        description="Physical inventory count sessions · per-item variance tracking + reconciliation through StockMovement audit"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Cycle Counts' },
        ]}
      />
      <CycleCountListClient />
    </div>
  )
}
