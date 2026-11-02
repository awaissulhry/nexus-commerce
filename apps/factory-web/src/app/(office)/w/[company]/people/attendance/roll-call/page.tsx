import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RollCall } from '../../../../../../../areas/people/attendance/rollcall/RollCall'

export const metadata: Metadata = { title: 'Roll call · Nexus Factory' }

/** People › Attendance › Roll call (a new tab: who is in now by name, for an evacuation; each opening is recorded). */
export default function PeopleRollCallPage() {
  return (
    <Suspense>
      <RollCall />
    </Suspense>
  )
}
