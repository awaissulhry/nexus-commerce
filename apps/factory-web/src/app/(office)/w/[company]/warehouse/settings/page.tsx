import { Suspense } from 'react'
import type { Metadata } from 'next'
import { WarehouseSettingsPage } from '../../../../../../areas/warehouse/settings/WarehouseSettingsPage'

export const metadata: Metadata = { title: 'Warehouse rules · Nexus Factory' }

/**
 * Warehouse › Settings › Warehouse rules (SCR-258, B-W2b-355; areas/warehouse/nav.ts, inventory.stock.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container. `?scope=all` every company's rules
 * (else the address's company), `?site=<id>` the site whose default places are shown.
 */
export default function WarehouseSettingsRoute() {
  return (
    <Suspense>
      <WarehouseSettingsPage />
    </Suspense>
  )
}
