import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LotRecord } from '../../../../../../../areas/compliance/tests/record/LotRecord'

export const metadata: Metadata = { title: 'Lot · Nexus Factory' }

/** Compliance › Tests & substances › a lot (SCR-054: its results, documents, release; `?tab=`). */
export default async function LotRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <LotRecord lotId={decodeURIComponent(id)} />
    </Suspense>
  )
}
