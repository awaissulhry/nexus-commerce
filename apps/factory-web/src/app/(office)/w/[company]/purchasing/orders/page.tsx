import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrdersPage } from '../../../../../../areas/purchasing/orders/list/OrdersPage'

export const metadata: Metadata = { title: 'Purchase orders · Nexus Factory' }

/**
 * Purchasing › Purchase orders (SCR-058; areas/purchasing/nav.ts, permission purchasing.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?status=`, `?waitingOver48h=true`,
 * `?q=`, `?new=1`).
 */
export default function PurchasingOrdersPage() {
  return (
    <Suspense>
      <OrdersPage />
    </Suspense>
  )
}
