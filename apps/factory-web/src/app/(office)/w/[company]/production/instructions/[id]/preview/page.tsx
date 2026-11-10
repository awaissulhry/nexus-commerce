import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InstructionPreview } from '../../../../../../../../areas/production/instructions/preview/InstructionPreview'

export const metadata: Metadata = { title: 'Floor preview · Nexus Factory' }

/** Production › Work instructions › Floor preview (SCR-285-preview, a new tab: `?version=&language=`). */
export default async function WorkInstructionPreviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InstructionPreview instructionId={decodeURIComponent(id)} />
    </Suspense>
  )
}
