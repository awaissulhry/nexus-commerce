import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InlineRecord } from '../../../../../../../../areas/quality/inspections/inline/InlineRecord'

export const metadata: Metadata = { title: 'In-line check · Nexus Factory' }

/** Quality › Inspections › an in-process check (SCR-076-inline; `?tab=check|decision`). B-W2b-127. */
export default async function InlineCheckRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InlineRecord checkId={decodeURIComponent(id)} />
    </Suspense>
  )
}
