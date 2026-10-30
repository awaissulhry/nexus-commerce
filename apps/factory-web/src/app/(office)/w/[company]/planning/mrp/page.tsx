import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlanPage } from '../../../../../../areas/planning/mrp/PlanPage'

export const metadata: Metadata = { title: 'What to buy & make · Nexus Factory' }

/**
 * Planning › What to buy & make (SCR-055; areas/planning/nav.ts, permission planning.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?site=`, `?view=`, `?q=`, `?line=`).
 */
export default function PlanningMrpPage() {
  return (
    <Suspense>
      <PlanPage />
    </Suspense>
  )
}
