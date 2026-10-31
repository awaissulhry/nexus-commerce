import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SupplierRecord } from '../../../../../../../areas/purchasing/suppliers/record/SupplierRecord'

export const metadata: Metadata = { title: 'Supplier · Nexus Factory' }

/** Purchasing › Suppliers › a supplier (SCR-057; `?tab=overview|contacts|items|orders|activity`). */
export default async function SupplierPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <SupplierRecord partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
