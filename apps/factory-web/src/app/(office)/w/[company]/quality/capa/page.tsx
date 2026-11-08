import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CapaPage } from '../../../../../../areas/quality/capa/list/CapaPage'

export const metadata: Metadata = { title: 'Corrective actions · Nexus Factory' }

/**
 * Quality › Problems › Corrective actions (SCR-146; areas/quality/nav.ts, permission quality.capa.view): every CAPA and 8D
 * as a list or a board by stage. The client container reads `?view=`, `?q=`, `?type=`, `?priority=`, `?mode=board` and
 * New CAPA `?new=1` (`&from=Nonconformance|Complaint&ids=<id>,<id>`: opened from records).
 */
export default function QualityCapaPage() {
  return (
    <Suspense>
      <CapaPage />
    </Suspense>
  )
}
