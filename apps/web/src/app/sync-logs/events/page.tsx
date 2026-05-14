/**
 * ES.4 — /sync-logs/events
 *
 * Sync-focused ProductEvent feed: flat-file imports, sync job
 * outcomes (queued/succeeded/failed), and listing publish events.
 */

import PageHeader from '@/components/layout/PageHeader'
import EventsClient from './EventsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function SyncEventsPage() {
  return (
    <div>
      <PageHeader
        title="Event Log"
        subtitle="Sync jobs, flat-file imports, and listing publish events"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync Logs', href: '/sync-logs' },
          { label: 'Events' },
        ]}
      />
      <div className="max-w-5xl mx-auto px-6 py-6">
        <EventsClient />
      </div>
    </div>
  )
}
