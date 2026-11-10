import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ChangesPage } from '../../../../../../areas/products/changes/ChangesPage'

export const metadata: Metadata = { title: 'Changes & versions · Nexus Factory' }

/**
 * Products › Development › Changes & versions (SCR-117; areas/products/nav.ts, product.changes.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container. `?view=released`, `?tile=`,
 * `?kind=`, `?style=`, `?q=`, New change request `?new=1`, New change order `?newOrder=1&style=&request=`, Approve change
 * `?decide=<kind>:<id>`.
 */
export default function ChangesRoute() {
  return (
    <Suspense>
      <ChangesPage />
    </Suspense>
  )
}
