import PageHeader from '@/components/layout/PageHeader'
import SuppliersClient from './SuppliersClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * A4 — Suppliers cost & lead-time master.
 *
 * The replenishment engine reads a product's unit cost / MOQ / case-pack /
 * lead-time from the SupplierProduct row of its preferred supplier. Before
 * this page there was no UI to set those, so EOQ, working capital and
 * landed cost all read €0. Operators can now manage each supplier's catalog
 * inline and bulk-import a cost list — and setting a primary cost auto-wires
 * the product's preferred supplier so the number flows into the math.
 */
export default function SuppliersPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Suppliers"
        description="Per-product cost, MOQ, case-pack and lead-time that feed EOQ, working capital and landed cost in replenishment."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Suppliers' },
        ]}
      />
      <SuppliersClient />
    </div>
  )
}
