import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SampleRecord } from '../../../../../../../areas/products/samples/record/SampleRecord'

export const metadata: Metadata = { title: 'Sample round · Nexus Factory' }

/** Products › Samples & prototypes › a round (SCR-110-record; `?tab=request|sample|fit|approval|shipments|activity&panel=`). */
export default async function SampleRoundRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <SampleRecord roundId={decodeURIComponent(id)} />
    </Suspense>
  )
}
