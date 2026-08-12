/**
 * AR.S0 — Apply Rules, promoted from the landing tab to its own route.
 *
 * Same shape as ../bid, ../negative-targeting and ../keyword-tracker: force-dynamic, and a Suspense
 * boundary because the client reads `useSearchParams` (every view on this page is linkable — "which
 * campaigns may automation write to" should be a link pasted into a message, not a description of
 * where to click).
 *
 * The bare `/marketing/ads/rules-automation` route still renders the index's own grid. Whether it
 * eventually redirects here is an open operator decision and was not this session's to make.
 */
import { Suspense } from 'react'
import { ApplyRulesClient } from './ApplyRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ApplyRulesClient />
    </Suspense>
  )
}
