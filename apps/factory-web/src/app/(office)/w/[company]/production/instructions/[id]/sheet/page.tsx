import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InstructionSheet } from '../../../../../../../../areas/production/instructions/sheet/InstructionSheet'

export const metadata: Metadata = { title: 'Instruction sheet · Nexus Factory' }

/** Production › Work instructions › Instruction sheet PDF (SCR-285-pdf, a new tab: `?version=&language=it|en`). */
export default async function WorkInstructionSheetRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InstructionSheet instructionId={decodeURIComponent(id)} />
    </Suspense>
  )
}
