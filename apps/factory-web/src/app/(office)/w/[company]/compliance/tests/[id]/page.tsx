import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LotRecord } from '../../../../../../../areas/compliance/tests/record/LotRecord'

export const metadata: Metadata = { title: 'Lot · Nexus Factory' }

/** Compliance › Tests & substances › a lot (SCR-054: `?tab=results|release` — Results & limits, Documents & release; the old `documents` opens Documents & release, `activity` Results with the thread — B-TH-267). */
export default async function LotRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <LotRecord lotId={decodeURIComponent(id)} />
    </Suspense>
  )
}
