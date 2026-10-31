import { Suspense } from 'react'
import type { Metadata } from 'next'
import { HoldTags } from '../../../../../../../../areas/quality/holds/tag/HoldTags'

export const metadata: Metadata = { title: 'Hold tag · Nexus Factory' }

/** Quality › Holds › Hold tag (SCR-078 tab:qh-tag, a new tab; `?ids=` several holds: one tag each, printed from the browser). */
export default async function HoldTagRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <HoldTags holdId={decodeURIComponent(id)} />
    </Suspense>
  )
}
