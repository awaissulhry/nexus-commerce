/**
 * /reconciliation — Listing Reconciliation Hub (Phase RECON)
 *
 * Server component: fetches stats + first page of rows, hands off to
 * the client component for interactive review, filtering, and actions.
 *
 * Operator flow:
 *   1. Click "Run reconciliation" → POST /api/reconciliation/run
 *   2. Review rows — green (high confidence), amber (low confidence), red (unmatched)
 *   3. Confirm / re-link / ignore each row
 *   4. Once all PENDING rows are reviewed, Nexus knows about every live listing
 */

import { getBackendUrl } from '@/lib/backend-url'
import ReconciliationClient from './ReconciliationClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function fetchInitialData(channel: string, marketplace: string) {
  const backend = getBackendUrl()
  const base = `${backend}/api/reconciliation`

  const [statsRes, itemsRes] = await Promise.all([
    fetch(`${base}/stats?channel=${channel}&marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
    fetch(`${base}/items?channel=${channel}&marketplace=${marketplace}&status=PENDING&pageSize=50`, { cache: 'no-store' }).catch(() => null),
  ])

  const stats = statsRes?.ok ? await statsRes.json().catch(() => null) : null
  const items = itemsRes?.ok ? await itemsRes.json().catch(() => null) : null

  return { stats, items }
}

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Record<string, string>
}) {
  const channel = searchParams.channel ?? 'AMAZON'
  const marketplace = searchParams.marketplace ?? 'IT'

  const { stats, items } = await fetchInitialData(channel, marketplace)

  return (
    <ReconciliationClient
      channel={channel}
      marketplace={marketplace}
      initialStats={stats}
      initialItems={items}
    />
  )
}
