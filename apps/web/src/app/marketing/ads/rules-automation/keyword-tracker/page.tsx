/**
 * Keyword Tracker — the Rules & Automation tab for rank-based bid rules.
 *
 * U4 (2026-08-18) — this route now mounts `KeywordTrackerRulesClient`: page header · tab bar · ONE
 * rules card, which is what Helium 10's Keyword Tracker tab is (study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.10).
 *
 * `KeywordTrackerClient` — the eleven-block rank report this replaced (market gate, feed-health
 * line, watchlist panel, term grid, term drawer with chart / ASINs / campaigns / bid action /
 * change log) — is PARKED, not deleted: the files sit untouched beside this one, each with a PARKED
 * header, and `docs/2026-08-16-ra-parked-sections.md` names where each is headed. Every
 * keyword-tracker endpoint is still served.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { KeywordTrackerRulesClient } from './KeywordTrackerRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <KeywordTrackerRulesClient />
    </Suspense>
  )
}
