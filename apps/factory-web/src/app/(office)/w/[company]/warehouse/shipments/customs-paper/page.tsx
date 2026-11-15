import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PaperWindow } from '../../../../../../../areas/warehouse/shipments/export/window/PaperWindow'

export const metadata: Metadata = { title: 'Commercial invoice PDF · Nexus Factory' }

/** The Commercial invoice PDF window (SCR-654, a window page: WINDOW_PAGES; B-W2b-412; a CN 22 / CN 23 too): `?shipment=<id>&document=<id>`. */
export default function CustomsPaperWindowRoute() {
  return (
    <Suspense>
      <PaperWindow />
    </Suspense>
  )
}
