import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ExceptionsPage } from '../../../../../../areas/planning/exceptions/ExceptionsPage'

export const metadata: Metadata = { title: 'Exceptions · Nexus Factory' }

/**
 * Planning › Exceptions (SCR-125; areas/planning/nav.ts, permission planning.view): what the planning runs could not
 * solve, as a queue to clear. The company layout above loaded the session and draws the Office shell; the page is the
 * client container (`?site=` `?view=` `?kind=` `?q=` `?open=`).
 */
export default function PlanningExceptionsPage() {
  return (
    <Suspense>
      <ExceptionsPage />
    </Suspense>
  )
}
