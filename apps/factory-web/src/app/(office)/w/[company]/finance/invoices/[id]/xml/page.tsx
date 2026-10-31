import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InvoiceXml } from '../../../../../../../../areas/finance/invoices/xml/InvoiceXml'

export const metadata: Metadata = { title: 'Invoice XML · Nexus Factory' }

/** Finance › an invoice's legal XML shown readable (SCR-081-xml; a new tab; `?view=source` for the file itself). */
export default async function FinanceInvoiceXmlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InvoiceXml invoiceId={id} />
    </Suspense>
  )
}
