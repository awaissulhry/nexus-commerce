/**
 * HV.1 — Keyword Harvest, promoted from a tab to its own route.
 *
 * Same shape as ../negative-targeting, ../keyword-tracker and ../automations: force-dynamic, and a
 * Suspense boundary because the client reads `useSearchParams`.
 *
 * Every view here is linkable, and `?minOrders=` is the one that matters: the whole finding of the
 * study is that the threshold decides whether this tab has any content, so "look at this" has to be
 * a link that carries the threshold rather than a description of where to click.
 */
import { Suspense } from 'react'
import { KeywordHarvestClient } from './KeywordHarvestClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <KeywordHarvestClient />
    </Suspense>
  )
}
