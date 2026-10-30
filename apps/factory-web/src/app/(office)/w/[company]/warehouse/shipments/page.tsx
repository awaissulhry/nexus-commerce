import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShipmentsPage } from '../../../../../../areas/warehouse/shipments/list/ShipmentsPage'

export const metadata: Metadata = { title: 'Shipments · Nexus Factory' }

/**
 * Warehouse › Shipments (SCR-066; areas/warehouse/nav.ts, permission shipping.view): the ship-today queue with the
 * carrier cut-offs, then every shipment (`?rows=today|packed|shipped|delivered|cancelled|all`, `?q=`, `?carrier=`;
 * `?new=1&order=<sales order id>` opens New shipment with that order chosen).
 */
export default function WarehouseShipmentsPage() {
  return (
    <Suspense>
      <ShipmentsPage />
    </Suspense>
  )
}
