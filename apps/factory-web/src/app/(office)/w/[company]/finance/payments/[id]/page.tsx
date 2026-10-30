import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PaymentRecord } from '../../../../../../../areas/finance/payments/record/PaymentRecord'

export const metadata: Metadata = { title: 'Payment · Nexus Factory' }

/** Finance › a payment (SCR-082 record; `?tab=allocation|bank`). */
export default async function FinancePaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <PaymentRecord paymentId={id} />
    </Suspense>
  )
}
