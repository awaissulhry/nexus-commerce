/**
 * Placement — the Rules & Automation tab for placement rules.
 *
 * U2 (2026-08-17) — this route now mounts `PlacementRulesClient`: page header · tab bar · ONE rules
 * card, which is what Helium 10's Placement tab is (study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.8).
 *
 * `PlacementClient` — the fourteen-block page this replaced (its own scope bar, census cells, lane
 * split, "the hour", the campaign×lane grid with the inline lane editor, the inspector rail and the
 * bulk panel) — is PARKED, not deleted: the files sit untouched beside this one, each with a PARKED
 * header, and `docs/2026-08-16-ra-parked-sections.md` names where each section is headed. The
 * PLC.3 write path is untouched and still served.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { PlacementRulesClient } from './PlacementRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PlacementRulesClient />
    </Suspense>
  )
}
