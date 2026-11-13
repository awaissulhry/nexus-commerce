import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ConfirmationPdf } from '../../../../../../../../areas/sales/orders/confirmation/ConfirmationPdf'

export const metadata: Metadata = { title: 'Order confirmation · Nexus Factory' }

/** B-W2b-323: the order confirmation PDF (design sales.orders tab:orders.confirmation, SCR-430), opened in a new tab. */
export default async function SalesOrderConfirmationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ConfirmationPdf orderId={id} />
    </Suspense>
  )
}
