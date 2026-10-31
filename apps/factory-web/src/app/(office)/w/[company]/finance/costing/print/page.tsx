import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CostingPrint } from '../../../../../../../areas/finance/costing/print/CostingPrint'

export const metadata: Metadata = { title: 'Variance report · Nexus Factory' }

/** Finance › Costing › Variance report (print), opened in a new tab from Standard vs actual's ⋯; the print stylesheet hides the frame. */
export default function VarianceReportPrintPage() {
  return (
    <Suspense>
      <CostingPrint />
    </Suspense>
  )
}
