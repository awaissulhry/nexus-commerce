import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CutRecord } from '../../../../../../../areas/production/cutting/record/CutRecord'

export const metadata: Metadata = { title: 'Cut · Nexus Factory' }

/**
 * Production › Cutting › a cut (SCR-238, the Cut record: one work order's leather; `?tab=lay|pieces|yield|tickets`). The
 * company layout above loaded the session and the shell.
 */
export default async function ProductionCutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <CutRecord workOrderId={id} />
    </Suspense>
  )
}
