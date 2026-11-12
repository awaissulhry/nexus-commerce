import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TransferRecord } from '../../../../../../../areas/warehouse/transfers/record/TransferRecord'

export const metadata: Metadata = { title: 'Transfer · Nexus Factory' }

/** Warehouse › a transfer between sites (SCR-361; `?tab=lines|transit|received`). The company layout above loaded the session and shell. */
export default async function WarehouseTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <TransferRecord transferId={id} />
    </Suspense>
  )
}
