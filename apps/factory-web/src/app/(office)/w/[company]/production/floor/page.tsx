import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FloorNowPage } from '../../../../../../areas/production/wip/FloorNowPage'

export const metadata: Metadata = { title: 'Floor now · Nexus Factory' }

/**
 * Production › Floor now (SCR-073; areas/production/nav.ts, permission workorders.view). The company layout above loaded
 * the session and draws the Office shell; the page is the client container, which loads the floor's WIP through the API.
 */
export default function ProductionFloorPage() {
  return (
    <Suspense>
      <FloorNowPage />
    </Suspense>
  )
}
