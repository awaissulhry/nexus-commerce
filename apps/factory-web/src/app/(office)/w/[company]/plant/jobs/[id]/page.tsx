import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobRecord } from '../../../../../../../areas/plant/jobs/record/JobRecord'

export const metadata: Metadata = { title: 'Maintenance job · Nexus Factory' }

/** Plant › a maintenance job (SCR-149 record; `?tab=problem|handback|activity`). The company layout above loaded the shell. */
export default async function PlantJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <JobRecord jobId={id} />
    </Suspense>
  )
}
