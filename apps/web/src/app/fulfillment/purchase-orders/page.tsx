import PageHeader from '@/components/layout/PageHeader'
import PurchaseOrdersClient from './PurchaseOrdersClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Purchase Orders — operator-facing PO list with R.7 approval workflow.
 *
 * State machine surface for transitioning POs:
 *   DRAFT → REVIEW → APPROVED → SUBMITTED → ACKNOWLEDGED
 * Plus CANCELLED from any pre-SUBMITTED state.
 *
 * Pre-this page, /fulfillment/replenishment created DRAFT POs but
 * there was no UI to advance them — DB confirmed 6/6 POs stuck in
 * DRAFT. Operators can now drive the approval flow end-to-end here.
 */
export default function PurchaseOrdersPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Purchase Orders"
        description="Approval workflow for supplier orders · Click any PO for transitions + audit trail"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Purchase Orders' },
        ]}
      />
      <PurchaseOrdersClient />
    </div>
  )
}
