import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReceivePage } from '../../../../../../../areas/warehouse/receipts/receive/ReceivePage'

export const metadata: Metadata = { title: 'Receive goods · Nexus Factory' }

/**
 * Warehouse › Receipts › receive goods against a purchase order (SCR-063 with its lots and hides one by one, SCR-061/062;
 * `?order=<purchase order id>`, `?lines=<order line ids>`). The receipt is posted whole, in one step.
 */
export default function WarehouseReceivePage() {
  return (
    <Suspense>
      <ReceivePage />
    </Suspense>
  )
}
