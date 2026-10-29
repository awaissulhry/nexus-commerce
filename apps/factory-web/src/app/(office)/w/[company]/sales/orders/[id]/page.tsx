import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrderRecord } from '../../../../../../../areas/sales/orders/record/OrderRecord'

export const metadata: Metadata = { title: 'Order · Nexus Factory' }

/**
 * Sales › an order (SCR-039; `?tab=lines|dates|production|shipments|money|documents|activity`). The company layout above
 * loaded the session and the shell.
 */
export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <OrderRecord orderId={id} />
    </Suspense>
  )
}
