import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DemandPage } from '../../../../../../areas/planning/demand/DemandPage'

export const metadata: Metadata = { title: 'Demand & forecast · Nexus Factory' }

/**
 * Planning › Long range › Demand & forecast (SCR-374; areas/planning/nav.ts, permission planning.view): the demand at a glance,
 * the demand over time by layer (the time-phased grid with its cell popover) and the demand rows with their source. The company
 * layout above loaded the session and draws the Office shell; the page is the client container (`?site=` `?bucket=` `?weeks=`
 * `?layers=` `?q=`, the list's `?layer=` `?rq=` `?style=` `?colour=` `?size=` `?mtm=` `?cell=`).
 */
export default function PlanningDemandPage() {
  return (
    <Suspense>
      <DemandPage />
    </Suspense>
  )
}
