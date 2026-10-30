import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CountRecord } from '../../../../../../../areas/warehouse/counts/record/CountRecord'

export const metadata: Metadata = { title: 'Count · Nexus Factory' }

/** Warehouse › a count (SCR-132 record; `?tab=lines|differences|approval`). The company layout above loaded the session and shell. */
export default async function WarehouseCountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <CountRecord countId={id} />
    </Suspense>
  )
}
