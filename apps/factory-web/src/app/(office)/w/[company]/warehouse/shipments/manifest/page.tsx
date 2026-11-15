import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ManifestWindow } from '../../../../../../../areas/warehouse/shipments/end-of-day/window/ManifestWindow'

export const metadata: Metadata = { title: 'End-of-day manifest · Nexus Factory' }

/** The End-of-day manifest PDF window (SCR-652, a window page: WINDOW_PAGES; B-W2b-412): `?manifest=<id>`. */
export default function ManifestWindowRoute() {
  return (
    <Suspense>
      <ManifestWindow />
    </Suspense>
  )
}
