import type { Metadata } from 'next'
import { Suspense } from 'react'
import { HealthPage } from '../../../../../../areas/plant/health/HealthPage'

export const metadata: Metadata = { title: 'Health surveillance · Nexus Factory' }

/**
 * Plant › Health & safety › Health surveillance (SCR-212; areas/plant/nav.ts, permission safety.health.view, also opened by
 * safety.health.plans and safety.health.views): the protected page — the note first, then the due list, the judgements and the
 * plans per role. The client container reads `?tile=`, `?status=`, `?type=`, `?jstate=` and the dialogs' ids.
 */
export default function HealthRoute() {
  return (
    <Suspense>
      <HealthPage />
    </Suspense>
  )
}
