import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReadyToShipPage } from '../../../../../../areas/warehouse/ready-to-ship/ReadyToShipPage'

export const metadata: Metadata = { title: 'Ready to ship · Nexus Factory' }

/**
 * Warehouse › Outbound › Ready to ship (owb- order workflow; areas/warehouse/nav.ts, permission shipping.view): every order with ready
 * garments by customer, One shipment for the n orders, Add to SH-…, and every shipment with the chips Open · On the way · Arrived · All
 * (owb-ss3 step 3.4, design plan § 5n). Its address joins OFFICE_PAGES at the lead's nav flip (shell/nav/office-nav.ts: DECLARED_PAGES →
 * OFFICE_PAGES), so until then no row shows it.
 */
export default function WarehouseReadyToShipPage() {
  return (
    <Suspense>
      <ReadyToShipPage />
    </Suspense>
  )
}
