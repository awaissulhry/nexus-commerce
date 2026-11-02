import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PastExport } from '../../../../../../../areas/people/payroll/record/PastExport'

export const metadata: Metadata = { title: 'Past export · Nexus Factory' }

/** People › Payroll export › one file made for the labour consultant (SCR-159-record; ⌘-click a row of Exports for a new tab). */
export default async function PeoplePastExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <PastExport exportId={id} />
    </Suspense>
  )
}
