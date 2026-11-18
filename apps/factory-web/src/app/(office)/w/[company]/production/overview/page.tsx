import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OverviewPage } from '../../../../../../areas/production/overview/OverviewPage'

export const metadata: Metadata = { title: 'Production overview · Nexus Factory' }

/**
 * Production › Overview (F-PR-04; areas/production/nav.ts, permission workorders.view): the area's first page — `/production` opens
 * it (shell/office/office-entry.ts, the first built row). The company layout above loaded the session and draws the Office shell;
 * the page is the client container, which reads GET /production/overview and the open issues through the API.
 */
export default function ProductionOverviewPage() {
  return (
    <Suspense>
      <OverviewPage />
    </Suspense>
  )
}
