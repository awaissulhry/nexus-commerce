/** Rules & Automation (Helium 10 Ads / Adtomic match) — R1: the Rules-tab campaign
 *  grid, built on the shared AdsDataGrid + AdsPageHeader.
 *  DPS.3 — the active tab now comes from ?tab=, so the client reads useSearchParams and
 *  needs a Suspense boundary. */
import { Suspense } from 'react'
import { RulesAutomationClient } from './RulesAutomationClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={<div className="h10-rules-page" />}>
      <RulesAutomationClient />
    </Suspense>
  )
}
