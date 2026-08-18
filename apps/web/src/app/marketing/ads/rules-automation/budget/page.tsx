/**
 * Budget Rules — the Rules & Automation tab for budget rules.
 *
 * U6 (2026-08-18) — this route now mounts `BudgetRulesClient`: page header · tab bar · ONE rules
 * card, which is what Helium 10's Budget tab is (study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.5).
 *
 * `BudgetClient` — the fourteen-block page this replaced (filter bar, census, ratchet warning, the
 * campaigns/rules grid with Restore-to-baseline and Transfer, the guardrails + baseline card) — is
 * PARKED, not deleted: the files sit untouched beside this one, each with a PARKED header, and
 * `docs/2026-08-16-ra-parked-sections.md` names where each is headed (Budget Manager, Control Room
 * › Guardrails, Analytics).
 *
 * ⚠ Every budget endpoint is still served and the write gate is untouched. The €1-floor ratchet
 * condition remains stated on Budget Pacing & Schedules and Control Room › Activity.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { BudgetRulesClient } from './BudgetRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BudgetRulesClient />
    </Suspense>
  )
}
