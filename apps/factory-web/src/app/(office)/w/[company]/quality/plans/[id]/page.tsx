import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PlanRecord } from '../../../../../../../areas/quality/plans/record/PlanRecord'

export const metadata: Metadata = { title: 'Inspection plan · Nexus Factory' }

/** Quality › Inspection plans & AQL › a plan (SCR-077-plan; `?tab=checks|sampling|applies|versions&version=&approve=1`). */
export default async function InspectionPlanRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <PlanRecord planId={decodeURIComponent(id)} />
    </Suspense>
  )
}
