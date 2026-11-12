import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SourcingPage } from '../../../../../../areas/purchasing/sourcing/SourcingPage'

export const metadata: Metadata = { title: 'RFQs & sourcing · Nexus Factory' }

/**
 * Purchasing › Sourcing & claims › RFQs & sourcing (SCR-222; B-W2b-347; areas/purchasing/nav.ts, permission purchasing.view).
 * The company layout above loaded the session and draws the Office shell; the page is the client container (`?rows=`,
 * `?status=`, `?q=`, `?new=1`).
 */
export default function PurchasingSourcingPage() {
  return (
    <Suspense>
      <SourcingPage />
    </Suspense>
  )
}
