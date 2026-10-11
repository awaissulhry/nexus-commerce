/**
 * Negative Targeting — the Rules & Automation tab that stops ads waste (2026-10-11, Negative Targeting page programme
 * wave 2, lane NVIEW).
 *
 * Mounts `NegativesClient`: header · tab bar · tiles · [Wasting | Stopped | Rules]. Wasting lists our keywords and the
 * shoppers' search terms that waste (pause and keep paused · negative exact / phrase); Stopped lists every kept-paused
 * keyword and standing negative; Rules is lane NRVIEW's `rules/WasteRulesView`. One record modal per row, every write
 * reviewed before it is sent, Done with Undo.
 *
 * `NegativeRulesClient` (the rules grid this replaces) and the sixteen-block `NegativeTargetingClient` with its parts stay
 * PARKED beside this file, untouched: nothing here imports them. Every server-side protection (the whitelist, the
 * converting-term guard, the write gate, the kept-paused lock) is armed whatever this page shows.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { NegativesClient } from './NegativesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NegativesClient />
    </Suspense>
  )
}
