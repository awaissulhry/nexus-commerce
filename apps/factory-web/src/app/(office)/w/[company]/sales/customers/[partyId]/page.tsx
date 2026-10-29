import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PartyRecord } from '../../../../../../../areas/parties/_shared/PartyRecord'

export const metadata: Metadata = { title: 'Customer · Nexus Factory' }

/** Sales › Customers › a customer (SCR-033; `?tab=overview|addresses|tax|orders|documents|activity`). */
export default async function CustomerPage({ params }: { params: Promise<{ partyId: string }> }) {
  const { partyId } = await params
  return (
    <Suspense>
      <PartyRecord side="customers" partyId={decodeURIComponent(partyId)} />
    </Suspense>
  )
}
