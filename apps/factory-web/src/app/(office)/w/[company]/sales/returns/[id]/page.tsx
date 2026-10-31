import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RmaRecord } from '../../../../../../../areas/sales/returns/record/RmaRecord'

export const metadata: Metadata = { title: 'Return · Nexus Factory' }

/** Sales › Returns & repairs › a return (SCR-112; `?tab=lines|inspection|credit|shipments|activity`, `?do=receive`). */
export default async function ReturnRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <RmaRecord returnId={decodeURIComponent(id)} />
    </Suspense>
  )
}
