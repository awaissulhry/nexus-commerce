import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RosterPrint } from '../../../../../../../areas/people/shifts/print/RosterPrint'

export const metadata: Metadata = { title: 'Roster · Nexus Factory' }

/** People › Shifts › Roster (a new tab: a page per line for the notice board, printed or saved as a PDF from the browser). */
export default function PeopleRosterPrintPage() {
  return (
    <Suspense>
      <RosterPrint />
    </Suspense>
  )
}
