/**
 * Keyword Harvest — the Rules & Automation tab for harvesting search terms into keywords (2026-10-11, wave 2).
 *
 * Mounts `HarvestClient`: header · tab bar · [Terms | Rules | Sources] · tiles · the view. The Terms view lists every
 * search term that sells (one row per term × product × market) with every harvest action on the page itself: harvest to
 * the suggested place or to one you pick (a new campaign or portfolio too), approve or reject what waits for you, skip,
 * unskip and undo — each reviewed, then Done with Undo. The page never writes to Amazon directly: a harvest is one
 * approval request, the same as Claude's.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { HarvestClient } from './HarvestClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <HarvestClient />
    </Suspense>
  )
}
