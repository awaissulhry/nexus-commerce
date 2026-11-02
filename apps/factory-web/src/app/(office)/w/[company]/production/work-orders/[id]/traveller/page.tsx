import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TravellerPdf } from '../../../../../../../../areas/production/work-orders/every-shift/traveller/TravellerPdf'

export const metadata: Metadata = { title: 'Traveller · Nexus Factory' }

/** Traveller PDF with QR (design production.workorders tab:wo-tab-traveller), opened in a new tab from the work order. */
export default async function ProductionWorkOrderTravellerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <TravellerPdf workOrderId={id} />
    </Suspense>
  )
}
