import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LulTab } from '../../../../../../../areas/people/attendance/lul/LulTab'

export const metadata: Metadata = { title: 'LUL calendar · Nexus Factory' }

/** People › Attendance › LUL calendar (a new tab: the sealed calendar of a closed month; each opening is recorded). */
export default function PeopleLulPage() {
  return (
    <Suspense>
      <LulTab />
    </Suspense>
  )
}
