import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CustomerRecord } from '../../../../../../../areas/sales/customers/record/CustomerRecord'

export const metadata: Metadata = { title: 'Customer · Nexus Factory' }

/** Sales › Customers › a customer (SCR-033; `?tab=overview|addresses|terms|orders|portal`; Terms & requirements holds the Commercial terms; B-TH-260: old `tax`/`requirements` → terms, `documents`/`activity` open the thread). */
export default async function CustomerPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <CustomerRecord partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
