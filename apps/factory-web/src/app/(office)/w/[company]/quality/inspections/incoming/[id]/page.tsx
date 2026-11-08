import { Suspense } from 'react'
import type { Metadata } from 'next'
import { IncomingRecord } from '../../../../../../../../areas/quality/inspections/incoming/IncomingRecord'

export const metadata: Metadata = { title: 'Incoming inspection · Nexus Factory' }

/** Quality › Inspections › an incoming inspection (SCR-076-incoming; `?tab=units|decision`). B-W2b-127. */
export default async function IncomingInspectionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <IncomingRecord inspectionId={decodeURIComponent(id)} />
    </Suspense>
  )
}
