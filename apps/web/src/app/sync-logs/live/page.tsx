/**
 * RT.19 — /sync-logs/live activity feed.
 *
 * Rolling tail of the SSE bus (order events + sync alerts) with
 * filters by event type. The "tail -f" view of the pipeline —
 * complementary to /sync-logs/webhooks (which is the persisted
 * WebhookEvent log; /sync-logs/live is the live ephemeral stream).
 */

import PageHeader from '@/components/layout/PageHeader'
import LiveActivityClient from './LiveActivityClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function SyncLogsLivePage() {
  return (
    <div>
      <PageHeader
        title="Live activity feed"
        subtitle="Real-time tail of every event flowing through the sync pipeline"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync logs', href: '/sync-logs' },
          { label: 'Live' },
        ]}
      />
      <LiveActivityClient />
    </div>
  )
}
