import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ReportRecord } from '../../../../../../../../../areas/compliance/register/accidents/record/ReportRecord'

export const metadata: Metadata = { title: 'Product-safety report · Nexus Factory' }

/** Compliance › PPE register › a product-safety report (SCR-421-record, B-W2b-357; RECORD_PAGES.ProductSafetyReport). */
export default async function SafetyReportRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ReportRecord reportId={decodeURIComponent(id)} />
    </Suspense>
  )
}
