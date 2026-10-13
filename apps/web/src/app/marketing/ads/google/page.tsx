import { Suspense } from 'react'
import { GoogleAdsClient } from './GoogleAdsClient'

export const dynamic = 'force-dynamic'

/**
 * Google Ads — the read-only Google tab of the Ads console (step 1a PLAN.md L8; step 1b PLAN-1B.md M3).
 * Suspense stays: the client reads `useSearchParams` (`?view=`, `?campaign=&tab=`).
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <GoogleAdsClient />
    </Suspense>
  )
}
