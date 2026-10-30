import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CustomerRecord } from '../../../../../../../areas/sales/customers/record/CustomerRecord'

export const metadata: Metadata = { title: 'Customer · Nexus Factory' }

/** Sales › Customers › a customer (SCR-033; `?tab=overview|addresses|tax|orders|documents|activity`; Tax & terms holds the Commercial terms). */
export default async function CustomerPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <CustomerRecord partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
