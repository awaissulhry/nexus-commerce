import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LotRecord } from '../../../../../../../areas/warehouse/lots/record/LotRecord'

export const metadata: Metadata = { title: 'Lot · Nexus Factory' }

/** Warehouse › a lot (SCR-201-record; `?tab=overview|trace|moves|activity`). The company layout above loaded the session and shell. */
export default async function WarehouseLotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <LotRecord lotId={id} />
    </Suspense>
  )
}
