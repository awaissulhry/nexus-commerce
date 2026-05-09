import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
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
export default async function PurchaseOrdersPage() {
  const t = await getServerT()
  return (
    <div className="space-y-3">
      <PageHeader
        title={t('po.pageTitle')}
        description={t('po.pageDescription')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('po.pageTitle') },
        ]}
      />
      <PurchaseOrdersClient />
    </div>
  )
}
