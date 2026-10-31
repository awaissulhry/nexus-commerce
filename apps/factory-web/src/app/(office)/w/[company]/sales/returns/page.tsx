import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReturnsPage } from '../../../../../../areas/sales/returns/ReturnsPage'

export const metadata: Metadata = { title: 'Returns & repairs · Nexus Factory' }

/**
 * Sales › After-sales › Returns & repairs (SCR-111, B-W2a-77; areas/sales/nav.ts, permission sales.returns.view): customer
 * returns and repairs in one grid. The company layout above loaded the session and draws the Office shell; the page is
 * the client container (`?view=`, `?q=`, `?new=return|repair`).
 */
export default function SalesReturnsPage() {
  return (
    <Suspense>
      <ReturnsPage />
    </Suspense>
  )
}
