/**
 * L.16.1 — /sync-logs/alerts (rules + events).
 *
 * Two-column layout: rules on the left (list + create), events on
 * the right (history with acknowledge/resolve actions).
 *
 * Backed by /api/sync-logs/alerts/{rules,events} (L.16.0).
 */

import PageHeader from '@/components/layout/PageHeader'
import AlertsClient from './AlertsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AlertsPage() {
  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle="Rule-based alerts on error rate, latency, queue depth, error groups, and stale crons"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync Logs', href: '/sync-logs' },
          { label: 'Alerts' },
        ]}
      />
      <AlertsClient />
    </div>
  )
}
