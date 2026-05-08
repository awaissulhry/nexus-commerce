// M.7 — Phase B publish-status page.
//
// Surfaces the same audit data the V.1 verification CLI script
// produces, but live-rendered + auto-polled. Operator no longer
// needs to drop to a terminal to monitor channel-write rollout.

import PublishStatusClient from './PublishStatusClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function PublishStatusPage() {
  return (
    <PublishStatusClient
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'Publish status' },
      ]}
    />
  )
}
