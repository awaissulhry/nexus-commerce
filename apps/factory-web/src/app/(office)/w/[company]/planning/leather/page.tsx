import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LeatherPage } from '../../../../../../areas/planning/leather/LeatherPage'

export const metadata: Metadata = { title: 'Leather & cut plan · Nexus Factory' }

/**
 * Planning › Leather & cut plan (SCR-252; areas/planning/nav.ts, permission planning.view): the leather need per order with
 * one shade's answer, the certified protectors, the planned against actual yield. The company layout above loaded the
 * session and draws the Office shell; the page is the client container (`?site=` `?tile=` `?feas=` `?q=` `?open=`).
 */
export default function PlanningLeatherPage() {
  return (
    <Suspense>
      <LeatherPage />
    </Suspense>
  )
}
