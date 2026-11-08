import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PlansPage } from '../../../../../../areas/quality/plans/PlansPage'

export const metadata: Metadata = { title: 'Inspection plans & AQL · Nexus Factory' }

/**
 * Quality › Settings › Inspection plans & AQL (SCR-077; areas/quality/nav.ts, quality.plans.view). The company layout above
 * loaded the session and draws the Office shell; the page is the client container. `?tab=plans|aql|triggers|calculator`,
 * the Plans tab's `?stage=` `?status=` `?q=` and New plan `?new=1` / `?copy=<version>`, a profile's `?profile=`, a rule's
 * `?rule=<id>|new`, the calculator's `?lot=&level=&aql=&major=&minor=`.
 */
export default function InspectionPlansRoute() {
  return (
    <Suspense>
      <PlansPage />
    </Suspense>
  )
}
