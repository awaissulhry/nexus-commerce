import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CountsPage } from '../../../../../../areas/warehouse/counts/list/CountsPage'

export const metadata: Metadata = { title: 'Counts · Nexus Factory' }

/**
 * Warehouse › In the warehouse › Counts (SCR-132; areas/warehouse/nav.ts, permission inventory.counts.view): cycle counts
 * and the year-end physical inventory. The company layout above loaded the session and draws the Office shell; the page
 * is the client container (`?view=`, `?q=`, `?site=`, `?new=1`).
 */
export default function WarehouseCountsPage() {
  return (
    <Suspense>
      <CountsPage />
    </Suspense>
  )
}
