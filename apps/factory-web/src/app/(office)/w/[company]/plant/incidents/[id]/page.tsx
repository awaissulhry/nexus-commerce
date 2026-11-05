import type { Metadata } from 'next'
import { Suspense } from 'react'
import { IncidentRecord } from '../../../../../../../areas/plant/incidents/record/IncidentRecord'

export const metadata: Metadata = { title: 'Incident · Nexus Factory' }

/** Plant › an incident (SCR-210-record; `?tab=report|actions|authority`). The company layout above loaded the shell. */
export default async function IncidentRecordRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <IncidentRecord incidentId={id} />
    </Suspense>
  )
}
