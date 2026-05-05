// AAA — /pim/review shell. Three-tab catalog organization workspace
// (Suggested Groups · Standalone Products · Parents) backed by the
// existing /api/amazon/pim/* endpoints + new /api/pim/* endpoints.

import PimReviewClient from './PimReviewClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function PIMReviewPage() {
  return <PimReviewClient />
}
