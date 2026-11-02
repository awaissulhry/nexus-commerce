import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/people/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'People report · Nexus Factory' }

/** People › People reports › Report (a new tab, for paper or a PDF): the filters on top, groups only. */
export default function PeopleReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
