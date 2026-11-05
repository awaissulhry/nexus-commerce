import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PpePage } from '../../../../../../areas/plant/ppe/PpePage'

export const metadata: Metadata = { title: 'PPE for workers · Nexus Factory' }

/**
 * Plant › Health & safety › PPE for workers (SCR-211; areas/plant/nav.ts, permission safety.view): who lacks what, every issue
 * and its receipt, the kits per role and the catalogue. The client container reads `?view=`, the lens's filters, `?issue=`,
 * `?item=`, `?void=`, `?scan=`.
 */
export default function PpeRoute() {
  return (
    <Suspense>
      <PpePage />
    </Suspense>
  )
}
