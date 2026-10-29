import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PartyRecord } from '../../../../../../../areas/parties/_shared/PartyRecord'

export const metadata: Metadata = { title: 'Supplier · Nexus Factory' }

/** Purchasing › Suppliers › a supplier (SCR-057; `?tab=overview|contacts|orders|activity`). */
export default async function SupplierPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <PartyRecord side="suppliers" partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
