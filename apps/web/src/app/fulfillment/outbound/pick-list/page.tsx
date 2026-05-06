import PageHeader from '@/components/layout/PageHeader'
import PickListClient from './PickListClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Pick list — operator-facing surface for warehouse picking.
 *
 * Pre-this page, pickers walked the warehouse with printed order
 * summaries, looked up SKU locations from memory, and the process
 * didn't scale past one or two warehouses. Audit (Operations agent
 * #2) flagged this as critical: 40-50% labor reduction in pick+pack
 * is the standard win for adopting a structured pick list.
 *
 * This page is the foundation. Future commits will add zone-aware
 * wave picking, mobile barcode scanning, and consolidated
 * cross-shipment pick paths.
 */
export default function PickListPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Pick List"
        description="Pickable shipments grouped by warehouse · click a row to mark picked · print for paper-based ops"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Outbound', href: '/fulfillment/outbound' },
          { label: 'Pick List' },
        ]}
      />
      <PickListClient />
    </div>
  )
}
