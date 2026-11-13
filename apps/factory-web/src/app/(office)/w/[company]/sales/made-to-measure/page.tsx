import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MtmPage } from '../../../../../../areas/sales/mtm/MtmPage'

export const metadata: Metadata = { title: 'Made-to-measure · Nexus Factory' }

/**
 * Sales › Special orders › Made-to-measure (SCR-036; areas/sales/nav.ts, permission sales.measurements.view): rider profiles
 * with their tiles. The client container reads `?view=`, `?garment=`, `?q=`, New measurements `?new=1` and Send a measurement
 * link `?link=1`.
 */
export default function SalesMadeToMeasurePage() {
  return (
    <Suspense>
      <MtmPage />
    </Suspense>
  )
}
