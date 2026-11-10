import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SamplesPage } from '../../../../../../areas/products/samples/SamplesPage'

export const metadata: Metadata = { title: 'Samples & prototypes · Nexus Factory' }

/**
 * Products › Development › Samples & prototypes (SCR-110; areas/products/nav.ts, sales.samples.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container. `?mode=table|calendar` (the
 * board by default), `?tile=`, `?kind=`, `?party=`, `?internal=1`, `?style=&revision=`, `?q=`, New sample request `?new=1`.
 */
export default function SamplesRoute() {
  return (
    <Suspense>
      <SamplesPage />
    </Suspense>
  )
}
