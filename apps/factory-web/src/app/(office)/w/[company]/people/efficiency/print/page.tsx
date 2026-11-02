import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EfficiencyPrint } from '../../../../../../../areas/people/efficiency/print/EfficiencyPrint'

export const metadata: Metadata = { title: 'Line report · Nexus Factory' }

/** People › Efficiency › Line report (a new tab, for paper): line level only. */
export default function PeopleEfficiencyPrintPage() {
  return (
    <Suspense>
      <EfficiencyPrint />
    </Suspense>
  )
}
