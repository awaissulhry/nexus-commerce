import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LaySheet } from '../../../../../../../areas/production/cutting/orders/sheet/LaySheet'

export const metadata: Metadata = { title: 'Lay sheet · Nexus Factory' }

/**
 * Production › Cutting › the lay sheet / cut ticket on paper (SCR-238-sheet, B-W2b-129; a new tab in window mode:
 * `?id=<cut order>&lay=<lay>`).
 */
export default function ProductionLaySheetPage() {
  return (
    <Suspense>
      <LaySheet />
    </Suspense>
  )
}
