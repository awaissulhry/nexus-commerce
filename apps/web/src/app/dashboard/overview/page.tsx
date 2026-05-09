// ZZ — Command Center / dashboard overview shell.
//
// Replaces the legacy KPI page with a multi-channel multi-marketplace
// command center backed by /api/dashboard/overview. All data fetching
// and rendering live in OverviewClient — this file just enforces the
// dynamic route flag and mounts the client.

import OverviewClient from './OverviewClient'

export const dynamic = 'force-dynamic'

export default function OverviewPage() {
  // DO.4 — Layout already pads with `p-3 md:p-6`. The previous
  // `px-6 py-6` here double-padded on mobile (12+24 = 36px each
  // side, ~17% of a 360px viewport eaten by chrome). Keep
  // `max-w-[1400px] mx-auto` so wide screens don't sprawl, but
  // let the layout drive padding so mobile gets the full glanceable
  // viewport the Command Center needs.
  return (
    <div className="max-w-[1400px] mx-auto">
      <OverviewClient />
    </div>
  )
}
