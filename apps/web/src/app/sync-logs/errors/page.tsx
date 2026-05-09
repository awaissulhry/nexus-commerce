/**
 * L.8.1 — /sync-logs/errors error-grouping drill-down.
 *
 * Sentry-tier rolled-up view of SyncLogErrorGroup. Each row is
 * "this error class happened N times since first seen" with
 * resolution actions (Resolve / Mute / Ignore / Reopen).
 *
 * Backed by GET /api/sync-logs/error-groups.
 */

import PageHeader from '@/components/layout/PageHeader'
import ErrorGroupsClient from './ErrorGroupsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function ErrorsPage() {
  return (
    <div>
      <PageHeader
        title="Error Groups"
        subtitle="Rolled-up sync errors with first/last seen, count, and resolution workflow"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync Logs', href: '/sync-logs' },
          { label: 'Errors' },
        ]}
      />
      <ErrorGroupsClient />
    </div>
  )
}
