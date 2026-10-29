import type { Metadata } from 'next'
import { Suspense } from 'react'
import { WorkOrdersPage } from '../../../../../../areas/production/work-orders/WorkOrdersPage'

export const metadata: Metadata = { title: 'Work orders · Nexus Factory' }

/**
 * Production › Work orders (SCR-069; areas/production/nav.ts, permission workorders.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container (`?view=`, `?q=`, `?new=1`).
 */
export default function ProductionWorkOrdersPage() {
  return (
    <Suspense>
      <WorkOrdersPage />
    </Suspense>
  )
}
