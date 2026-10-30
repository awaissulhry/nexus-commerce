import type { Metadata } from 'next'
import { Suspense } from 'react'
import { NewOrderPage } from '../../../../../../../areas/sales/orders/new/NewOrderPage'

export const metadata: Metadata = { title: 'New order · Nexus Factory' }

/**
 * Sales › Orders › New order (B-W2a-50; the list's New order dialog opens it with `?company=&party=&contact=&ref=`): a
 * typed order held on the screen until "Confirm order" makes it. The company layout above loaded the session and the
 * shell.
 */
export default function SalesNewOrderPage() {
  return (
    <Suspense>
      <NewOrderPage />
    </Suspense>
  )
}
