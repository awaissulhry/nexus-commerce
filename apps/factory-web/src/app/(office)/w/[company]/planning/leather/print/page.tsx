import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CutPlanPrint } from '../../../../../../../areas/planning/leather/print/CutPlanPrint'

export const metadata: Metadata = { title: 'Cut plan · Nexus Factory' }

/** Planning › Leather & cut plan › Cut plan (a new tab from the page's ⋯: the cut plan on paper; the print stylesheet hides the frame). */
export default function PlanningLeatherPrintPage() {
  return (
    <Suspense>
      <CutPlanPrint />
    </Suspense>
  )
}
