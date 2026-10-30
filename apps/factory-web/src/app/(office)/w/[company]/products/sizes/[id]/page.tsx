import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ScaleRecord } from '../../../../../../../areas/products/sizes/record/ScaleRecord'

export const metadata: Metadata = { title: 'Size scale · Nexus Factory' }

/** Products › Libraries › Sizes & measurements › a size scale (SCR-049; `?tab=sizes|points|whereused`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ScaleRecord scaleId={decodeURIComponent(id)} />
    </Suspense>
  )
}
