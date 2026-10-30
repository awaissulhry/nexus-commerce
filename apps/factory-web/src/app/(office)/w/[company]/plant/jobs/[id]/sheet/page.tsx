import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobSheet } from '../../../../../../../../areas/plant/jobs/sheet/JobSheet'

export const metadata: Metadata = { title: 'Job sheet · Nexus Factory' }

/** Plant › a maintenance job › its job sheet (a new tab, printed for the technician with a QR that opens the job). */
export default async function PlantJobSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <JobSheet jobId={id} />
    </Suspense>
  )
}
