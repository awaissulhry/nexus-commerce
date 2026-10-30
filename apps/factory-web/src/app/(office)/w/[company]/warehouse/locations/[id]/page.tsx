import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LocationRecord } from '../../../../../../../areas/warehouse/locations/record/LocationRecord'

export const metadata: Metadata = { title: 'Location · Nexus Factory' }

/** A location's record (SCR-065: `?tab=overview|stock`, `&inside=1`); the client container reads and saves it. */
export default function WarehouseLocationPage() {
  return (
    <Suspense>
      <LocationRecord />
    </Suspense>
  )
}
