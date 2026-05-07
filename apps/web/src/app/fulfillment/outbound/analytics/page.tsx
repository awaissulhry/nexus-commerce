import AnalyticsClient from './AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * O.31 — Outbound analytics. Cycle time, cost, late rate, carrier
 * performance, daily trend. Powers operator decisions about which
 * carriers to keep using and where SLA risk lives.
 */
export default function AnalyticsPage() {
  return <AnalyticsClient />
}
