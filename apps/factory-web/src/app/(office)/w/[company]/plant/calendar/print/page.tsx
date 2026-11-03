import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CalendarPrint } from '../../../../../../../areas/plant/calendar/print/CalendarPrint'

export const metadata: Metadata = { title: 'Safety calendar print · Nexus Factory' }

/** Plant › Health & safety › Safety calendar › Calendar (a new tab, for the periodic safety meeting): `?from=&to=`. */
export default function SafetyCalendarPrintRoute() {
  return (
    <Suspense>
      <CalendarPrint />
    </Suspense>
  )
}
