import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ComplaintsPage } from '../../../../../../areas/quality/complaints/ComplaintsPage'

export const metadata: Metadata = { title: 'Complaints · Nexus Factory' }

/**
 * Quality › Problems › Complaints (SCR-113 W2a part, B-W2a-65; areas/quality/nav.ts, permission quality.complaints.view):
 * customer complaints with severity, the safety escalation and the answer due. The company layout above loaded the
 * session and draws the Office shell; the page is the client container (`?view=`, `?q=`, `?open=<id>` the triage,
 * `?new=1` Log complaint).
 */
export default function QualityComplaintsPage() {
  return (
    <Suspense>
      <ComplaintsPage />
    </Suspense>
  )
}
