/**
 * P3.1 — /sync-logs/outbound-queue
 *
 * Operator view of the OutboundSyncQueue: active jobs, dead letters,
 * recent successes. Per-row retry/cancel + bulk actions.
 */

import PageHeader from '@/components/layout/PageHeader'
import OutboundQueueClient from './OutboundQueueClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function OutboundQueuePage() {
  return (
    <div>
      <PageHeader
        title="Outbound Sync Queue"
        subtitle="Monitor and manage pending, failed, and dead channel sync jobs"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync Logs', href: '/sync-logs' },
          { label: 'Queue' },
        ]}
      />
      <OutboundQueueClient />
    </div>
  )
}
