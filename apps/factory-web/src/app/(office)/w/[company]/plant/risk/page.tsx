import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RiskPage } from '../../../../../../areas/plant/risk/RiskPage'

export const metadata: Metadata = { title: 'Risk assessment · Nexus Factory' }

/**
 * Plant › Health & safety › Risk assessment (SCR-209; areas/plant/nav.ts, permission safety.view): the assessments (the DVR
 * per site with its versions and signatures), the improvement plan and the role sheets. The client container reads `?view=`,
 * `?tile=`, `?q=`, `?new=`, `?assessment=`, `?sheet=`, `?do=`, `?measure=`.
 */
export default function RiskRoute() {
  return (
    <Suspense>
      <RiskPage />
    </Suspense>
  )
}
