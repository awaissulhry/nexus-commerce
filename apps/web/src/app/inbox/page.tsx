/**
 * P5.2 — /inbox — Unified Triage Inbox.
 *
 * Priority-ordered feed of sync failures, unacknowledged alert events,
 * unread notifications, and webhook errors. Operators can retry, ack,
 * replay, or dismiss items from one place without navigating to four
 * different monitoring surfaces.
 */

import PageHeader from '@/components/layout/PageHeader'
import InboxClient from './InboxClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function InboxPage() {
  return (
    <div>
      <PageHeader
        title="Triage Inbox"
        subtitle="All signals that need your attention — sync failures, alerts, notifications, webhook errors"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Inbox' },
        ]}
      />
      <InboxClient />
    </div>
  )
}
