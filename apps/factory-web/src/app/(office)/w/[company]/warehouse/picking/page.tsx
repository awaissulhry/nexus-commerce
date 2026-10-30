import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PickingPage } from '../../../../../../areas/warehouse/picking/list/PickingPage'

export const metadata: Metadata = { title: 'Picking & kits · Nexus Factory' }

/**
 * Warehouse › In the warehouse › Picking & kits (SCR-237; areas/warehouse/nav.ts, permission inventory.stock.view): what
 * the floor must pick and whether the material is there. The company layout above loaded the session and draws the
 * Office shell; the page is the client container (`?view=`, `?q=`, `?site=`, `?open=`, `?new=1`).
 */
export default function WarehousePickingPage() {
  return (
    <Suspense>
      <PickingPage />
    </Suspense>
  )
}
