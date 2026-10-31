import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SupplierInvoiceRecord } from '../../../../../../../areas/finance/payables/record/SupplierInvoiceRecord'

export const metadata: Metadata = { title: 'Supplier invoice · Nexus Factory' }

/** Finance › a supplier invoice (SCR-153 record; `?tab=lines|match|approval|payment|activity`). */
export default async function FinanceSupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <SupplierInvoiceRecord invoiceId={id} />
    </Suspense>
  )
}
