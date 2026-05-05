// AAA — /pim/review shell. Three-tab catalog organization workspace
// (Suggested Groups · Standalone Products · Parents) backed by the
// existing /api/amazon/pim/* endpoints + new /api/pim/* endpoints.

import PimReviewClient from './PimReviewClient'

export const dynamic = 'force-dynamic'

export default function PIMReviewPage() {
  return <PimReviewClient />
}
