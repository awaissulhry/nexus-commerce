import type { Metadata } from 'next'
import { Suspense } from 'react'
import { XmlPage } from '../../../../../../../../areas/finance/payables/xml/XmlPage'

export const metadata: Metadata = { title: 'Supplier invoice as received · Nexus Factory' }

/** Finance › a supplier invoice as received (SCR-153 new tab: the XML as SDI delivered it, what it names, the PDF). */
export default async function FinanceSupplierInvoiceXmlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <XmlPage invoiceId={id} />
    </Suspense>
  )
}
