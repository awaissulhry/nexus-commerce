import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RecallPage } from '../../../../../../../../areas/compliance/register/depth/recall/RecallPage'

export const metadata: Metadata = { title: 'Recall or withdrawal · Nexus Factory' }

/** Compliance › PPE register › a recall or withdrawal (SCR-328, B-W2b-271; design pop:rg-recall, the Builder in page mode). */
export default async function RecallRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <RecallPage recallId={decodeURIComponent(id)} />
    </Suspense>
  )
}
