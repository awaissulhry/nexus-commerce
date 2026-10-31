import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PayablesPage } from '../../../../../../areas/finance/payables/PayablesPage'

export const metadata: Metadata = { title: 'Supplier invoices · Nexus Factory' }

/**
 * Finance › Payables & bank › Supplier invoices (SCR-153; areas/finance/nav.ts, permission payables.view): invoices from
 * SDI or typed from a foreign supplier's PDF, matched to the PO and the receipt, approved and paid (`?tile=`, `?q=`,
 * `?new=1` Add foreign invoice).
 */
export default function FinancePayablesPage() {
  return (
    <Suspense>
      <PayablesPage />
    </Suspense>
  )
}
