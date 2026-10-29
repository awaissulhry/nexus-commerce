import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InspectionRecord } from '../../../../../../../areas/quality/inspections/record/InspectionRecord'

export const metadata: Metadata = { title: 'Inspection · Nexus Factory' }

/** Quality › Inspections › an inspection (SCR-076; `?tab=result|checks|release`). */
export default async function InspectionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InspectionRecord inspectionId={decodeURIComponent(id)} />
    </Suspense>
  )
}
