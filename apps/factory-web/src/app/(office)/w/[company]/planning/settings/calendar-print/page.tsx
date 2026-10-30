import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CalendarPrint } from '../../../../../../../areas/planning/settings/print/CalendarPrint'

export const metadata: Metadata = { title: 'Plant calendar · Nexus Factory' }

/**
 * Planning › Planning settings › Plant calendar (print) (SCR-124-print; design planning.settings tab:calendar-print, "posted
 * on the notice board"): opened in a new tab from Calendars & shifts; the print stylesheet hides the frame.
 * `?site=&year=&cal=`.
 */
export default function PlantCalendarPrintRoute() {
  return (
    <Suspense>
      <CalendarPrint />
    </Suspense>
  )
}
