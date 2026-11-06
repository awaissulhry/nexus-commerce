import type { Metadata } from 'next'
import { Suspense } from 'react'
import { IncidentsPrint } from '../../../../../../../areas/plant/incidents/print/IncidentsPrint'

export const metadata: Metadata = { title: 'Incidents print · Nexus Factory' }

/** Plant › Health & safety › Incidents › the anonymised list for the safety meeting (a new tab): the list's own filters. */
export default function IncidentsPrintRoute() {
  return (
    <Suspense>
      <IncidentsPrint />
    </Suspense>
  )
}
