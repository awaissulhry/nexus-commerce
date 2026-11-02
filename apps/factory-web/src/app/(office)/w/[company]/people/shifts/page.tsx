import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShiftsPage } from '../../../../../../areas/people/shifts/ShiftsPage'

export const metadata: Metadata = { title: 'Shifts · Nexus Factory' }

/**
 * People › Shifts (SCR-263; areas/people/nav.ts, permission people.shifts.view): the roster sheet and the overtime requests.
 * The client container reads `?span=`, `?from=`, `?to=`, `?line=`, `?team=`, `?open=` and `?overtime=1`; the site is the top bar's.
 */
export default function PeopleShiftsPage() {
  return (
    <Suspense>
      <ShiftsPage />
    </Suspense>
  )
}
