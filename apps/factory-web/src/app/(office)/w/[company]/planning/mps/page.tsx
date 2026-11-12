import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MpsPage } from '../../../../../../areas/planning/mps/MpsPage'

export const metadata: Metadata = { title: 'Master schedule & S&OP · Nexus Factory' }

/**
 * Planning › Long range › Master schedule & S&OP (SCR-202; areas/planning/nav.ts, permission planning.view): in W2b the production
 * strategy per item (make to order, make to stock, assemble to order), each cell saved by itself, a bulk change with its review.
 * The company layout above loaded the session and draws the Office shell; the page is the client container (`?site=` `?q=`
 * `?kind=` `?strategy=` `?set=`).
 */
export default function PlanningMpsPage() {
  return (
    <Suspense>
      <MpsPage />
    </Suspense>
  )
}
