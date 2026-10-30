import type { Metadata } from 'next'
import { Suspense } from 'react'
import { HidesPage } from '../../../../../../areas/warehouse/hides/list/HidesPage'

export const metadata: Metadata = { title: 'Hides · Nexus Factory' }

/**
 * Warehouse › Main › Hides (SCR-200; areas/warehouse/nav.ts, permission inventory.stock.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?view=`, `?q=`, `?site=`, `?lot=`).
 */
export default function WarehouseHidesPage() {
  return (
    <Suspense>
      <HidesPage />
    </Suspense>
  )
}
