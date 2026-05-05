// ZZ — Command Center / dashboard overview shell.
//
// Replaces the legacy KPI page with a multi-channel multi-marketplace
// command center backed by /api/dashboard/overview. All data fetching
// and rendering live in OverviewClient — this file just enforces the
// dynamic route flag and mounts the client.

import OverviewClient from './OverviewClient'

export const dynamic = 'force-dynamic'

export default function OverviewPage() {
  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto">
      <OverviewClient />
    </div>
  )
}
