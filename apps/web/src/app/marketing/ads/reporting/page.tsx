import { ReportingClient } from './ReportingClient'

// Matches every other page in this console (dashboard, trust, campaigns, portfolios,
// health) — the catalogue is static today but RPT.2 makes it read live coverage.
export const dynamic = 'force-dynamic'

export default function Page() {
  return <ReportingClient />
}
