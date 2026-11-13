import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PromisePage } from '../../../../../../areas/planning/promise/PromisePage'

export const metadata: Metadata = { title: 'Promise dates · Nexus Factory' }

/**
 * Planning › Dates › Promise dates (SCR-109; areas/planning/nav.ts, permission planning.promise.view): the promise tiles, the
 * open order lines with the planned finish, available to promise, the Promise calculator and re-promise. The company layout
 * above loaded the session and draws the Office shell; the page is the client container (`?site=` `?tile=` `?risk=` `?q=`
 * `?style=` `?weeks=` `?week=` `?calc=1` `?quote=` `?repromise=` `?proposal=`).
 */
export default function PlanningPromisePage() {
  return (
    <Suspense>
      <PromisePage />
    </Suspense>
  )
}
