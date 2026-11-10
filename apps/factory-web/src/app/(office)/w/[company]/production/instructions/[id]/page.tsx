import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InstructionRecord } from '../../../../../../../areas/production/instructions/record/InstructionRecord'

export const metadata: Metadata = { title: 'Work instruction · Nexus Factory' }

/** Production › Work instructions › an instruction (SCR-285; `?tab=steps|media|versions|acks&version=&compare=&approve=1`). */
export default async function WorkInstructionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InstructionRecord instructionId={decodeURIComponent(id)} />
    </Suspense>
  )
}
