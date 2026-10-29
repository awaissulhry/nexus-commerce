import type { Metadata } from 'next'
import { Suspense } from 'react'
import { WorkOrderRecord } from '../../../../../../../areas/production/work-orders/record/WorkOrderRecord'

export const metadata: Metadata = { title: 'Work order · Nexus Factory' }

/**
 * Production › a work order (SCR-070 … SCR-072; `?tab=overview|materials|cutting|bundles|operations|quality|activity`,
 * `?at=<seq>` the bundles waiting at an operation). The company layout above loaded the session and the shell.
 */
export default async function ProductionWorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <WorkOrderRecord workOrderId={id} />
    </Suspense>
  )
}
