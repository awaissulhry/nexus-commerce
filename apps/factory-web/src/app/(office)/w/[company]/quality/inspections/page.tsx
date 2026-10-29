import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InspectionsPage } from '../../../../../../areas/quality/inspections/InspectionsPage'

export const metadata: Metadata = { title: 'Inspections · Nexus Factory' }

/**
 * Quality › Inspections (SCR-075; areas/quality/nav.ts, quality.inspections.view). The company layout above loaded the
 * session and draws the Office shell; the page is the client container. `?view=` names the list (`waiting`, `onHold`,
 * `reversed`, `lots` …; the API's own `?onHold=true`, `?waitingRelease=true`, `?status=OPEN` are read too), `?open=<id>`
 * opens a release in its DetailModal, `?new=1` opens New inspection, `?rules=1` the quality rules.
 */
export default function InspectionsRoute() {
  return (
    <Suspense>
      <InspectionsPage />
    </Suspense>
  )
}
