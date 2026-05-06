import PageHeader from '@/components/layout/PageHeader'
import QcQueueClient from './QcQueueClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * QC queue — supervisor surface for items currently in FAIL or HOLD
 * status. Shows the photos captured during the receive flow and the
 * notes from the line worker, then exposes Pass (release into stock)
 * and Scrap (terminal disposition) actions.
 *
 * Pre-this page, items in HOLD/FAIL accumulated invisibly — only
 * surfaced as a JSON count from /qc-queue endpoint, never displayed
 * to the supervisor doing the actual review.
 */
export default function QcQueuePage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="QC Queue"
        description="Items held for supervisor review · Pass to receive into stock, Scrap for terminal disposition (supplier credit, write-off)"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Inbound', href: '/fulfillment/inbound' },
          { label: 'QC Queue' },
        ]}
      />
      <QcQueueClient />
    </div>
  )
}
