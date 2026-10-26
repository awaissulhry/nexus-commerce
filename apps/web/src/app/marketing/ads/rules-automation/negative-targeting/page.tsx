/**
 * Negative Targeting — the Rules & Automation tab that stops ads waste (2026-10-11, Negative Targeting page programme
 * wave 2, lane NVIEW).
 *
 * Mounts `NegativesClient` (the redesign, 2026-10-26: the platform's list page): header · tab bar · tiles · banners · the
 * filter bar and its chips · ONE grid card [Wasting | Stopped | Words | Rules] · a note. Wasting lists our keywords and
 * the shoppers' search terms that waste (pause and keep paused · negative exact / phrase); Stopped lists every kept-paused
 * keyword and standing negative; Words lists the words that waste across search terms (Block word: a negative phrase);
 * Rules is lane NRVIEW's `rules/WasteRulesView`. One record modal per row, every write
 * reviewed before it is sent, Done with Undo.
 *
 * New rule and Edit open the old rule builder (negative-targeting type) as a full page, with its one extra section,
 * "Stop waste — may run alone" (Owner 2026-10-11, wave 4). Every server-side protection (the whitelist, the
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
