import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShipmentRecord } from '../../../../../../../areas/warehouse/shipments/record/ShipmentRecord'

export const metadata: Metadata = { title: 'Shipment · Nexus Factory' }

/** Warehouse › a shipment (SCR-067; `?tab=lines|documents|carrier|tracking|export|invoice|activity`). The company layout loaded the shell. */
export default async function WarehouseShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ShipmentRecord shipmentId={id} />
    </Suspense>
  )
}
