import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JudgementCopy } from '../../../../../../../areas/plant/health/copy/JudgementCopy'

export const metadata: Metadata = { title: 'Judgement copy · Nexus Factory' }

/** Plant › Health & safety › Health surveillance › a judgement's copy (a new tab; each opening is recorded). */
export default function JudgementCopyRoute() {
  return (
    <Suspense>
      <JudgementCopy />
    </Suspense>
  )
}
