/**
 * /reconciliation — Listing Reconciliation Hub (Phase RECON)
 *
 * Server component: resolves the channel/marketplace searchParams and hands
 * off to ReconciliationLoader, which fetches stats + the first page of rows
 * CLIENT-side (the API session cookie lives on the API origin, so server
 * fetches can never authenticate) and then renders ReconciliationClient.
 *
 * Operator flow:
 *   1. Click "Run reconciliation" → POST /api/reconciliation/run
 *   2. Review rows — green (high confidence), amber (low confidence), red (unmatched)
 *   3. Confirm / re-link / ignore each row
 *   4. Once all PENDING rows are reviewed, Nexus knows about every live listing
 */

import ReconciliationLoader from './ReconciliationLoader'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const sp = await searchParams
  const channel = sp.channel ?? 'AMAZON'
  const marketplace = sp.marketplace ?? 'ALL'

  return <ReconciliationLoader channel={channel} marketplace={marketplace} />
}
