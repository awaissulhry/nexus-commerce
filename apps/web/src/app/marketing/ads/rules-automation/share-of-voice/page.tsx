/**
 * Share of Voice — the Rules & Automation tab for SOV rules.
 *
 * U3 (2026-08-18) — this route now mounts `SovRulesClient`: page header · tab bar · ONE rules card,
 * which is what Helium 10's Share of Voice tab is (study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.9).
 *
 * `ShareOfVoiceClient` — the fourteen-block market-share report this replaced — is PARKED, not
 * deleted: the files sit untouched beside this one, each with a PARKED header, and
 * `docs/2026-08-16-ra-parked-sections.md` names where each section is headed (Analytics › Coverage,
 * Reporting). Every SOV endpoint is still served.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { SovRulesClient } from './SovRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SovRulesClient />
    </Suspense>
  )
}
