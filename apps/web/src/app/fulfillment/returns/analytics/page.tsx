import AnalyticsClient from './AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * R7.1 — Returns analytics workspace.
 *
 * Reads the extended /returns/analytics endpoint and renders:
 *   - KPI strip (counts + trend %)
 *   - 30-day daily trend chart
 *   - Per-channel return-rate table (returns / orders / rate %)
 *   - Top return SKUs (10 most-returned)
 *   - Top reasons
 *   - Avg processing time SLA tile
 */
export default function ReturnsAnalyticsPage() {
  return <AnalyticsClient />
}
