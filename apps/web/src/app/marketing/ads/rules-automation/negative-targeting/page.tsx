/**
 * Negative Targeting — the Rules & Automation tab for negative-keyword rules.
 *
 * U5 (2026-08-18) — this route now mounts `NegativeRulesClient`: page header · tab bar · ONE rules
 * card, which is what Helium 10's Negative Targeting tab is (study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.4). It also gains a "+ Rule" button, which this
 * page never had.
 *
 * `NegativeTargetingClient` — the sixteen-block page this replaced (census, negations/terms grid,
 * term drawer, removal dialog, Attention, Protected terms, Wasteful words, the rules table and the
 * record) — is PARKED, not deleted: the files sit untouched beside this one, each with a PARKED
 * header, and `docs/2026-08-16-ra-parked-sections.md` names where each is headed.
 *
 * ⚠ Every negative-targeting endpoint is still served and every server-side protection is still
 * armed — the whitelist, the converting-term guard and the write gate are not UI.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { NegativeRulesClient } from './NegativeRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NegativeRulesClient />
    </Suspense>
  )
}
