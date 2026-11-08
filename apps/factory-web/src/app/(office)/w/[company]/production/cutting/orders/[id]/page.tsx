import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CutOrderRecord } from '../../../../../../../../areas/production/cutting/orders/record/CutOrderRecord'

export const metadata: Metadata = { title: 'Cut order · Nexus Factory' }

/**
 * Production › Cutting › a cut order (SCR-238-order, B-W2b-129: a cut order of several work orders with its lays, pieces, yield
 * and tickets; `?tab=lay|pieces|yield|tickets`). The company layout above loaded the session and the shell.
 */
export default async function ProductionCutOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <CutOrderRecord cutOrderId={id} />
    </Suspense>
  )
}
