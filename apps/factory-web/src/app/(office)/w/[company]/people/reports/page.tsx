import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/people/reports/ReportsPage'

export const metadata: Metadata = { title: 'People reports · Nexus Factory' }

/**
 * People › People reports (SCR-264; areas/people/nav.ts, permission people.attendance.view): the attendance and earnings reports. The
 * client container reads `?month=`, `?to=`, `?group=`, `?team=`, `?earnings=`.
 */
export default function PeopleReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
