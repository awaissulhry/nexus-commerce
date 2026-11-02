import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TravellerPdf } from '../../../../../../../areas/production/work-orders/every-shift/traveller/TravellerPdf'

export const metadata: Metadata = { title: 'Travellers · Nexus Factory' }

/** The travellers of several work orders in one PDF (`?ids=a,b`), opened in a new tab from the list's selection. */
export default function ProductionTravellersPage() {
  return (
    <Suspense>
      <TravellerPdf />
    </Suspense>
  )
}
