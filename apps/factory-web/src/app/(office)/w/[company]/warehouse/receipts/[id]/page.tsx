import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReceiptRecord } from '../../../../../../../areas/warehouse/receipts/record/ReceiptRecord'

export const metadata: Metadata = { title: 'Receipt · Nexus Factory' }

/** Warehouse › a goods receipt (SCR-063; `?tab=lines|lots|activity`). The company layout above loaded the session and shell. */
export default async function WarehouseReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ReceiptRecord receiptId={id} />
    </Suspense>
  )
}
