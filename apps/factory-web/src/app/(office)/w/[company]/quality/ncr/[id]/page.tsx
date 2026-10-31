import { Suspense } from 'react'
import type { Metadata } from 'next'
import { NcrRecord } from '../../../../../../../areas/quality/ncr/record/NcrRecord'

export const metadata: Metadata = { title: 'Nonconformance · Nexus Factory' }

/** Quality › Nonconformances › an NCR (SCR-145; `?tab=problem|containment|disposition|linked|activity`). */
export default async function NcrRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <NcrRecord ncrId={decodeURIComponent(id)} />
    </Suspense>
  )
}
