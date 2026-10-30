import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ClaimRecord } from '../../../../../../../areas/purchasing/claims/record/ClaimRecord'

export const metadata: Metadata = { title: 'Supplier claim · Nexus Factory' }

/**
 * Purchasing › a supplier claim or return (SCR-131 record; `?tab=claim|goods|credit|activity`). The company layout above
 * loaded the session and the shell.
 */
export default async function PurchasingClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ClaimRecord claimId={id} />
    </Suspense>
  )
}
