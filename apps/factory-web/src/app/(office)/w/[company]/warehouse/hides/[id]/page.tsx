import type { Metadata } from 'next'
import { Suspense } from 'react'
import { HideRecord } from '../../../../../../../areas/warehouse/hides/record/HideRecord'

export const metadata: Metadata = { title: 'Hide · Nexus Factory' }

/** Warehouse › a hide (SCR-200-record; `?tab=overview|cuts|moves`). The company layout above loaded the session and shell. */
export default async function WarehouseHidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <HideRecord hideId={id} />
    </Suspense>
  )
}
