import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CustomerRecord } from '../../../../../../../areas/sales/customers/record/CustomerRecord'

export const metadata: Metadata = { title: 'Customer · Nexus Factory' }

/**
 * Sales › Customers › a customer (SCR-033; F-SA-270: the customer's own view; F-SA-271: `?tab=work|quotes|overview|money|people|terms|portal`,
 * no tab = the first the reader sees; old `orders` → work (All orders), `addresses` → people, `tax` → terms, `requirements` → terms at
 * its Requirements part, `documents` / `activity` → the overview with the thread).
 */
export default async function CustomerPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <CustomerRecord partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
