import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobSheet } from '../../../../../../../../areas/purchasing/subcontracting/job-sheet/JobSheet'

export const metadata: Metadata = { title: 'Job sheet · Nexus Factory' }

/**
 * Purchasing › a subcontract order › Job sheet (design tab:job-sheet, "printed and sent with the kit"): opened in a new tab
 * from the record's ⋯ Print job sheet; drawn for paper (the browser prints it, or saves it as a PDF).
 */
export default async function PurchasingSubcontractJobSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <JobSheet orderId={id} />
    </Suspense>
  )
}
