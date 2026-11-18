import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MtmPage } from '../../../../../../areas/sales/mtm/MtmPage'

export const metadata: Metadata = { title: 'Made-to-measure · Nexus Factory' }

/**
 * Sales › Special orders › Made-to-measure (SCR-036; areas/sales/nav.ts, permission sales.measurements.view). F-SA-222: Orders |
 * Riders — the made-to-measure orders (the Orders sheet locked to `kind=mtm`; orders.view) and the rider profiles with their tiles
 * (`?segment=riders`). The client container reads the segment, the sheet's own terms (`?view=board`, `?profile=`, …) and the rider
 * list's `?view=`, `?garment=`, `?q=`, New measurements `?new=1` and Send a measurement link `?link=1` (each of these opens Riders).
 */
export default function SalesMadeToMeasurePage() {
  return (
    <Suspense>
      <MtmPage />
    </Suspense>
  )
}
