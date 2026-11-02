import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EfficiencyPage } from '../../../../../../areas/people/efficiency/EfficiencyPage'

export const metadata: Metadata = { title: 'Efficiency · Nexus Factory' }

/**
 * People › Efficiency (SCR-161; areas/people/nav.ts, permission people.efficiency.view): lines and operations, never a person. The
 * client container reads `?from=`, `?to=`, `?line=`, `?style=`, `?compare=1`, `?day=`, `?open=`.
 */
export default function PeopleEfficiencyPage() {
  return (
    <Suspense>
      <EfficiencyPage />
    </Suspense>
  )
}
