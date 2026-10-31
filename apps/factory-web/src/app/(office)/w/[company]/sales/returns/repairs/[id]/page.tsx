import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RepairRecord } from '../../../../../../../../areas/sales/returns/repair/RepairRecord'

export const metadata: Metadata = { title: 'Repair · Nexus Factory' }

/** Sales › Returns & repairs › a repair or alteration (SCR-112; `?tab=intake|work|safety|return|activity`). */
export default async function RepairRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <RepairRecord repairId={decodeURIComponent(id)} />
    </Suspense>
  )
}
