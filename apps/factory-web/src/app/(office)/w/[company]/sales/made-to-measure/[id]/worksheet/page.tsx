import type { Metadata } from 'next'
import { Suspense } from 'react'
import { WorksheetTab } from '../../../../../../../../areas/sales/mtm/worksheet/WorksheetTab'

export const metadata: Metadata = { title: 'Made-to-measure worksheet · Nexus Factory' }

/** Sales › Made-to-measure › a rider's worksheet and order form PDF (SCR-431, tab:mtm.worksheet), a new tab. */
export default async function WorksheetRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <WorksheetTab profileId={decodeURIComponent(id)} />
    </Suspense>
  )
}
