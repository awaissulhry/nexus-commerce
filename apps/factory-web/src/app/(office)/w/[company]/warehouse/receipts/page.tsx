import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReceiptsPage } from '../../../../../../areas/warehouse/receipts/list/ReceiptsPage'

export const metadata: Metadata = { title: 'Receipts · Nexus Factory' }

/**
 * Warehouse › Inbound › Receipts (SCR-063; areas/warehouse/nav.ts, permission inventory.stock.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container (`?view=expected|posted|…`,
 * `?q=`, `?new=1`).
 */
export default function WarehouseReceiptsPage() {
  return (
    <Suspense>
      <ReceiptsPage />
    </Suspense>
  )
}
