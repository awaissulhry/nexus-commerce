import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ValuationPrint } from '../../../../../../../areas/finance/reports/print/ValuationPrint'

export const metadata: Metadata = { title: 'Stock valuation · Nexus Factory' }

/** Finance › Reports › Stock valuation (print), opened in a new tab from Finance reports' ⋯; the print stylesheet hides the frame. */
export default function StockValuationPrintPage() {
  return (
    <Suspense>
      <ValuationPrint />
    </Suspense>
  )
}
