import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Timesheet } from '../../../../../../../../areas/people/attendance/timesheet/Timesheet'

export const metadata: Metadata = { title: 'Timesheet · Nexus Factory' }

/** People › Attendance › a person's timesheet (a new tab: their month, printed from the browser). */
export default async function PeopleTimesheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <Timesheet timesheetId={id} />
    </Suspense>
  )
}
