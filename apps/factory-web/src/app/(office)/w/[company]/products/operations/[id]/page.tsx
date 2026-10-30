import { Suspense } from 'react'
import type { Metadata } from 'next'
import { OperationRecord } from '../../../../../../../areas/products/operations/record/OperationRecord'

export const metadata: Metadata = { title: 'Operation · Nexus Factory' }

/** Products › Libraries › Operations › an operation (SCR-049; `?tab=definition|minutes|whereused`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <OperationRecord operationId={decodeURIComponent(id)} />
    </Suspense>
  )
}
