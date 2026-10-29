import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrdersPage } from '../../../../../../areas/sales/orders/list/OrdersPage'

export const metadata: Metadata = { title: 'Orders · Nexus Factory' }

/**
 * Sales › Orders (SCR-038; areas/sales/nav.ts, permission orders.view). The company layout above loaded the session and
 * draws the Office shell; the page is the client container (`?late=true`, `?deposit=OPEN`, `?status=`, `?rows=all`,
 * `?q=`, `?view=board`).
 */
export default function SalesOrdersPage() {
  return (
    <Suspense>
      <OrdersPage />
    </Suspense>
  )
}
