import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RequestsPage } from '../../../../../../areas/purchasing/requests/RequestsPage'

export const metadata: Metadata = { title: 'Requests to buy · Nexus Factory' }

/**
 * Purchasing › Requests to buy (SCR-236; areas/purchasing/nav.ts, permission purchasing.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?view=`, `?site=`, `?kind=`, `?q=`,
 * `?group=`, `?open=`).
 */
export default function PurchasingRequestsPage() {
  return (
    <Suspense>
      <RequestsPage />
    </Suspense>
  )
}
