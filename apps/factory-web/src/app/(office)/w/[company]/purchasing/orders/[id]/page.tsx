import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrderRecord } from '../../../../../../../areas/purchasing/orders/record/OrderRecord'

export const metadata: Metadata = { title: 'Purchase order · Nexus Factory' }

/**
 * Purchasing › a purchase order (SCR-059; `?tab=lines|answer|receipts|documents|activity`). The company layout above
 * loaded the session and the shell.
 */
export default async function PurchasingOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <OrderRecord orderId={id} />
    </Suspense>
  )
}
