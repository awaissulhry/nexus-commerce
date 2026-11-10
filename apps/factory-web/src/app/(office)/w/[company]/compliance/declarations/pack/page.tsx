import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PackWindow } from '../../../../../../../areas/compliance/declarations/windows/PackWindow'

export const metadata: Metadata = { title: 'Shipment compliance pack · Nexus Factory' }

/** The shipment compliance pack window (SCR-052-pack, a window page: WINDOW_PAGES): `?shipment=<id>&version=<pack document>`. */
export default function CompliancePackRoute() {
  return (
    <Suspense>
      <PackWindow />
    </Suspense>
  )
}
