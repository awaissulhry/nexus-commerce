import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LotsPage } from '../../../../../../areas/compliance/tests/LotsPage'

export const metadata: Metadata = { title: 'Tests & substances · Nexus Factory' }

/**
 * Compliance › Tests & substances (SCR-054; areas/compliance/nav.ts, quality.lots.view): the lots with their Cr VI
 * results and release. `?view=` names a saved filter; the API's own `?onHold=true` and `?status=` are read too.
 */
export default function LotsRoute() {
  return (
    <Suspense>
      <LotsPage />
    </Suspense>
  )
}
