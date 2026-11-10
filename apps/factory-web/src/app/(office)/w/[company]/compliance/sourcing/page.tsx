import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SourcingPage } from '../../../../../../areas/compliance/sourcing/SourcingPage'

export const metadata: Metadata = { title: 'Sourcing & claims · Nexus Factory' }

/**
 * Compliance › Sustainability › Sourcing & claims (SCR-215; areas/compliance/nav.ts, permission compliance.certificates.view):
 * the sustainability claims register with words, scope, evidence and expiry. The client container reads `?state=`, `?kind=`,
 * `?scope=`, `?q=`, `?open=`, `?tab=`, `?do=`, `?new=`, `?replaces=`.
 */
export default function SourcingRoute() {
  return (
    <Suspense>
      <SourcingPage />
    </Suspense>
  )
}
