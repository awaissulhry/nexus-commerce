import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LotsPage } from '../../../../../../areas/warehouse/lots/list/LotsPage'

export const metadata: Metadata = { title: 'Lots & traceability · Nexus Factory' }

/**
 * Warehouse › Main › Lots & traceability (SCR-201; areas/warehouse/nav.ts, permission inventory.stock.view). The company
 * layout above loaded the session and draws the Office shell; the page is the client container (`?view=`, `?q=`, `?site=`).
 */
export default function WarehouseLotsPage() {
  return (
    <Suspense>
      <LotsPage />
    </Suspense>
  )
}
