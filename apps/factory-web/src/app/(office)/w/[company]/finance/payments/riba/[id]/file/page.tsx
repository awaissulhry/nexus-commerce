import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RibaFilePage } from '../../../../../../../../../areas/finance/payments/riba/file/RibaFilePage'

export const metadata: Metadata = { title: 'Ri.Ba. file · Nexus Factory' }

/** Finance › Payments › a Ri.Ba. batch's CBI file (SCR-511, the new tab "Ri.Ba. file download": a file for the bank). */
export default async function FinanceRibaFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <RibaFilePage batchId={id} />
    </Suspense>
  )
}
