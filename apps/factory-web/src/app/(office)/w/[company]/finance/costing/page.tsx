import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CostingPage } from '../../../../../../areas/finance/costing/CostingPage'

export const metadata: Metadata = { title: 'Standard vs actual · Nexus Factory' }

/**
 * Finance › Costing › Standard vs actual (SCR-154; areas/finance/nav.ts, permission costing.view): the work orders
 * against their standard, the frozen standards and the cost ledger. The company layout above loaded the session and
 * draws the Office shell; the page is the client container, which reads the costs through the API.
 */
export default function FinanceCostingPage() {
  return (
    <Suspense>
      <CostingPage />
    </Suspense>
  )
}
