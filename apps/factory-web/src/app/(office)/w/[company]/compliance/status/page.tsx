import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StatusPage } from '../../../../../../areas/compliance/status/StatusPage'

export const metadata: Metadata = { title: 'Compliance status board · Nexus Factory' }

/**
 * Compliance › Status board (SCR-119; areas/compliance/nav.ts, permission compliance.certificates.view): readiness tiles, needs
 * action, the style × market matrix with each cell's checklist, gate refusals with the override, what expires next. The client
 * container reads `?markets=`, `?brand=`, `?gap=`, `?status=`, `?q=`, `?gate=`, `?feed=`, `?days=`.
 */
export default function ComplianceStatusPage() {
  return (
    <Suspense>
      <StatusPage />
    </Suspense>
  )
}
