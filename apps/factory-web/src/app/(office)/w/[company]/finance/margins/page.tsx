import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MarginsPage } from '../../../../../../areas/finance/margins/MarginsPage'

export const metadata: Metadata = { title: 'Margins · Nexus Factory' }

/**
 * Finance › Costing › Margins (SCR-155; areas/finance/nav.ts, permission costing.view): each order's margin as quoted, as
 * estimated now and so far, and by customer and style. The page is the client container, which reads the margins
 * through the API; price, cost and margin grains each hide their own figures.
 */
export default function FinanceMarginsPage() {
  return (
    <Suspense>
      <MarginsPage />
    </Suspense>
  )
}
