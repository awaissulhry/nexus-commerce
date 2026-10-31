import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShipmentPack } from '../../../../../../../../areas/warehouse/shipments/pack/ShipmentPack'

export const metadata: Metadata = { title: "Driver's pack · Nexus Factory" }

/**
 * Warehouse › a shipment › the driver's pack (SCR-067-pack; design tab:sh-tab-pack "All documents"): opened in a new tab
 * from the shipment's Documents (Print all) or ⋯; drawn for paper (the browser prints the sheet and every document at once).
 */
export default async function WarehouseShipmentPackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ShipmentPack shipmentId={id} />
    </Suspense>
  )
}
