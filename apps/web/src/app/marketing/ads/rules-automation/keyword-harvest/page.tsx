/**
 * Keyword Harvest — the Rules & Automation tab for harvest rules.
 *
 * U7 (2026-08-18) — this route now mounts `KeywordHarvestRulesClient`: page header · tab bar · the
 * pill [ Rules View | Ad Group View ] · one card. That is what Helium 10's Keyword Harvest tab is
 * (study `docs/2026-08-16-ra-h10-reference-study.md` §3.3), and the three things the operator named
 * for this page — Rules, Ad Group View, and the builder behind "+ Rule".
 *
 * `KeywordHarvestClient` — the eighteen-block page this replaced (candidates/harvested views, the
 * thresholds bar, census lede + strip, candidates grid, destination panel, promote dialog, actors
 * panel and the pending queue) — is PARKED, not deleted: the files sit untouched beside this one,
 * each with a PARKED header, and `docs/2026-08-16-ra-parked-sections.md` names where each is
 * headed (Suggestions, Analytics, Automations).
 *
 * ⚠ Every harvest endpoint is still served and the harvest engine's own arming is untouched.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { KeywordHarvestRulesClient } from './KeywordHarvestRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <KeywordHarvestRulesClient />
    </Suspense>
  )
}
