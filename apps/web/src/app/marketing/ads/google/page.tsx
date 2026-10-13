import { GoogleAdsClient } from './GoogleAdsClient'

export const dynamic = 'force-dynamic'

/** Google Ads step 1a — the read-only Google tab of the Ads console (PLAN.md L8). */
export default function Page() {
  return <GoogleAdsClient />
}
