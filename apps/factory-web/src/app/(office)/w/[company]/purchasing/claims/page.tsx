import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ClaimsPage } from '../../../../../../areas/purchasing/claims/list/ClaimsPage'

export const metadata: Metadata = { title: 'Returns & claims · Nexus Factory' }

/**
 * Purchasing › Sourcing & claims › Returns & claims (SCR-131; areas/purchasing/nav.ts, permission purchasing.view). The
 * company layout above loaded the session and draws the Office shell; the page is the client container (`?view=`,
 * `?kind=`, `?receipt=`, `?lot=`, `?q=`, `?return=1`).
 */
export default function PurchasingClaimsPage() {
  return (
    <Suspense>
      <ClaimsPage />
    </Suspense>
  )
}
