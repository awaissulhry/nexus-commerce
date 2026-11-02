import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AttendancePage } from '../../../../../../areas/people/attendance/AttendancePage'

export const metadata: Metadata = { title: 'Attendance · Nexus Factory' }

/**
 * People › Attendance (SCR-157; areas/people/nav.ts, permission people.attendance.view): days and anomalies, overtime to approve,
 * timesheets, the month close, who is in now. The client container reads `?month=`, `?team=`, `?line=`, `?tile=`, `?status=`,
 * `?anomaly=`, `?manual=1`, `?open=`, `?entry=`, `?new=1`, `?close=1`; the site is the top bar's.
 */
export default function PeopleAttendancePage() {
  return (
    <Suspense>
      <AttendancePage />
    </Suspense>
  )
}
