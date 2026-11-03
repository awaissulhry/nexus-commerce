import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CalendarPage } from '../../../../../../areas/plant/calendar/CalendarPage'

export const metadata: Metadata = { title: 'Safety calendar · Nexus Factory' }

/**
 * Plant › Health & safety › Safety calendar (SCR-267; areas/plant/nav.ts, permission safety.view): every legal safety
 * deadline in one place, the safety organisation and the RLS notice to INAIL. The client container reads `?view=`,
 * `?month=`, `?day=`, `?tile=`, `?from=`, `?to=`, `?ended=`, `?open=`, `?new=`, `?appoint=`, `?role=`, `?at=`, `?filing=`.
 */
export default function SafetyCalendarRoute() {
  return (
    <Suspense>
      <CalendarPage />
    </Suspense>
  )
}
