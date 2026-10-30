import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SubcontractRecord } from '../../../../../../../areas/purchasing/subcontracting/record/SubcontractRecord'

export const metadata: Metadata = { title: 'Subcontract order · Nexus Factory' }

/**
 * Purchasing › a subcontract order (SCR-128 record; `?tab=ops|kit|back|documents|activity`). The company layout above
 * loaded the session and the shell.
 */
export default async function PurchasingSubcontractOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <SubcontractRecord orderId={id} />
    </Suspense>
  )
}
