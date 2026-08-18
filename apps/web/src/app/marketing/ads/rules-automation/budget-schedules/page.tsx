/**
 * Budget Pacing & Schedules — the Rules & Automation tab for budget schedules.
 *
 * U8 (2026-08-18) — this route now mounts `BudgetSchedulesTabClient`: page header · tab bar · the
 * two-part card H10 has (hourly performance + the schedules grid). Study
 * `docs/2026-08-16-ra-h10-reference-study.md` §3.7.
 *
 * `BudgetSchedulesClient` — the pinned pacing band and six section cards this replaced — is PARKED,
 * not deleted: the files sit untouched beside this one, each with a PARKED header, and
 * `docs/2026-08-16-ra-parked-sections.md` names where each is headed (Budget Manager, Control Room,
 * Change Log). Every budget-manager and budget-schedule endpoint is still served.
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { BudgetSchedulesTabClient } from './BudgetSchedulesTabClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BudgetSchedulesTabClient />
    </Suspense>
  )
}
