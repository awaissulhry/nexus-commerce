import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DisplayPreviewPage } from '../../../../../../../areas/production/wip/display/DisplayPreviewPage'

export const metadata: Metadata = { title: 'Line TV · Nexus Factory' }

/**
 * Production › Floor now › Open line TV (SCR-173 display.preview; a window page in a new tab): the Office's preview of a
 * line's TV board. The company layout above loaded the session and draws the window frame.
 */
export default function ProductionFloorDisplayPage() {
  return (
    <Suspense>
      <DisplayPreviewPage />
    </Suspense>
  )
}
