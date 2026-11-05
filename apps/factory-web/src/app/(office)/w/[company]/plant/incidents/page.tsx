import type { Metadata } from 'next'
import { Suspense } from 'react'
import { IncidentsPage } from '../../../../../../areas/plant/incidents/IncidentsPage'

export const metadata: Metadata = { title: 'Incidents · Nexus Factory' }

/**
 * Plant › Health & safety › Incidents (SCR-210; areas/plant/nav.ts, permission safety.incidents.view): injuries, near misses
 * and hazards, anonymised by default, with the INAIL deadline banner. The client container reads `?rows=`, `?status=`,
 * `?from=`, `?to=`, `?q=`, `?new=`.
 */
export default function IncidentsRoute() {
  return (
    <Suspense>
      <IncidentsPage />
    </Suspense>
  )
}
