import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MilestonesPage } from '../../../../../../areas/planning/milestones/MilestonesPage'

export const metadata: Metadata = { title: 'Time & action · Nexus Factory' }

/**
 * Planning › Dates › Time & action (SCR-253; areas/planning/nav.ts, permission planning.view): the pre-production gates of the
 * open sales orders and their milestones (by date, as a list, one row per order), Waiting on a gate, Start before the gate. The
 * company layout above loaded the session and draws the Office shell; the page is the client container (`?view=` `?tile=`
 * `?q=` `?open=` `?add=`).
 */
export default function PlanningMilestonesPage() {
  return (
    <Suspense>
      <MilestonesPage />
    </Suspense>
  )
}
