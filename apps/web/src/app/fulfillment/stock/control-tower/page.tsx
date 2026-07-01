/**
 * Phase 6 T3 — /fulfillment/stock/control-tower
 *
 * Read-only per-SKU, per-channel inventory sync status surface.
 * The heavy lifting is in ControlTowerClient (client component).
 */

import PageHeader from '@/components/layout/PageHeader'
import ControlTowerClient from './ControlTowerClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ControlTowerPage() {
  return (
    <div>
      <PageHeader
        title="Sync Control Tower"
        subtitle="Per-SKU, per-channel inventory sync status"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Control Tower' },
        ]}
      />
      <ControlTowerClient />
    </div>
  )
}
