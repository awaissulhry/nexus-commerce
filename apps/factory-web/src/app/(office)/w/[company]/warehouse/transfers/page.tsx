import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TransfersPage } from '../../../../../../areas/warehouse/transfers/list/TransfersPage'

export const metadata: Metadata = { title: 'Transfers · Nexus Factory' }

/**
 * Warehouse › In the warehouse › Transfers (SCR-360; design warehouse.transfers, SCR-133; areas/warehouse/nav.ts, permission
 * inventory.stock.view): transfers between sites and the goods in transit. The company layout above loaded the session and
 * draws the Office shell; the page is the client container (`?tile=`, `?status=`, `?from=`, `?to=`, `?q=`, `?new=1`).
 */
export default function WarehouseTransfersPage() {
  return (
    <Suspense>
      <TransfersPage />
    </Suspense>
  )
}
