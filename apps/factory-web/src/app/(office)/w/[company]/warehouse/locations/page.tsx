import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LocationsPage } from '../../../../../../areas/warehouse/locations/list/LocationsPage'

export const metadata: Metadata = { title: 'Locations · Nexus Factory' }

/**
 * Warehouse › Settings › Locations (SCR-065; areas/warehouse/nav.ts, permission inventory.locations.view). The company
 * layout above loaded the session and draws the Office shell; the page is the client container (`?site=`,
 * `?archived=1`, `?q=`).
 */
export default function WarehouseLocationsPage() {
  return (
    <Suspense>
      <LocationsPage />
    </Suspense>
  )
}
