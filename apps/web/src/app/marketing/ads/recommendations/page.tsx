/**
 * SG.4 (2026-08-21) — Recommendations folded into Suggestions as its 7th tab (operator
 * decision 1). This route survives only as a redirect so old links, bookmarks and in-app
 * references keep landing somewhere true. The feed itself lives in
 * `../suggestions/RecommendationsView.tsx`; `RecommendationsClient.tsx` here is parked.
 */
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function Page() {
  redirect('/marketing/ads/suggestions?view=recommendations')
}
