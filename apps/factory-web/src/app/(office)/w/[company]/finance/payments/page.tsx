import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PaymentsPage } from '../../../../../../areas/finance/payments/list/PaymentsPage'

export const metadata: Metadata = { title: 'Payments · Nexus Factory' }

/**
 * Finance › Payments (SCR-082; permission payments.view): money received and where it is placed; Record payment
 * (`?new=1`, `&invoice=<id>` to place it on that invoice).
 */
export default function FinancePaymentsPage() {
  return (
    <Suspense>
      <PaymentsPage />
    </Suspense>
  )
}
