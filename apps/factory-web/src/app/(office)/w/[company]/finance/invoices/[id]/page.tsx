import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InvoiceRecord } from '../../../../../../../areas/finance/invoices/record/InvoiceRecord'

export const metadata: Metadata = { title: 'Invoice · Nexus Factory' }

/** Finance › an invoice (SCR-081; `?tab=lines|money|sdi`; the old `documents` opens SDI & documents, `activity` Lines & VAT with the thread — B-TH-268). */
export default async function FinanceInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InvoiceRecord invoiceId={id} />
    </Suspense>
  )
}
