import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InvoicesPage } from '../../../../../../areas/finance/invoices/list/InvoicesPage'

export const metadata: Metadata = { title: 'Invoices · Nexus Factory' }

/**
 * Finance › Invoices (SCR-080; areas/finance/nav.ts, permission invoices.view): where invoices stand, shipped goods not
 * invoiced yet with their legal deadline, and every invoice with its SDI and payment state (`?status=`, `?docType=`).
 */
export default function FinanceInvoicesPage() {
  return (
    <Suspense>
      <InvoicesPage />
    </Suspense>
  )
}
