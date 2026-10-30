import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LabelRecord } from '../../../../../../../areas/compliance/labels/record/LabelRecord'

export const metadata: Metadata = { title: 'Label · Nexus Factory' }

/** Compliance › Labels & marking › a label (SCR-053; `?tab=content|versions|prints`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <LabelRecord templateId={decodeURIComponent(id)} />
    </Suspense>
  )
}
