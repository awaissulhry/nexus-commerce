import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ValuationPage } from '../../../../../../areas/finance/reports/ValuationPage'

export const metadata: Metadata = { title: 'Finance reports · Nexus Factory' }

/**
 * Finance › Reports › Finance reports (SCR-239; areas/finance/nav.ts, permission inventory.stock.view): the stock
 * valuation at any date. The company layout above loaded the session and draws the Office shell; the page is the client
 * container, which reads the valuation through the API.
 */
export default function FinanceReportsPage() {
  return (
    <Suspense>
      <ValuationPage />
    </Suspense>
  )
}
