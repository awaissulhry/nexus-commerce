import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RequestsPage } from '../../../../../../areas/plant/requests/RequestsPage'

export const metadata: Metadata = { title: 'Machine requests · Nexus Factory' }

/**
 * Plant › Maintenance › Machine requests (SCR-148; areas/plant/nav.ts, permission plant.view): the breakdowns reported
 * from the stations, triaged in order. The company layout above loaded the session and draws the Office shell; the page
 * is the client container (`?view=`, `?tile=`, `?site=`, `?open=<request>`, `?report=1`).
 */
export default function PlantRequestsPage() {
  return (
    <Suspense>
      <RequestsPage />
    </Suspense>
  )
}
