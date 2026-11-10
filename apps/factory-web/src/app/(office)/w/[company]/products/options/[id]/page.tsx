import { Suspense } from 'react'
import type { Metadata } from 'next'
import { OptionGroupRecord } from '../../../../../../../areas/products/options/record/OptionGroupRecord'

export const metadata: Metadata = { title: 'Option group · Nexus Factory' }

/** Products › Libraries › Options & rules › an option group (SCR-114-record; `?tab=options|rules|effects|styles`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <OptionGroupRecord groupId={decodeURIComponent(id)} />
    </Suspense>
  )
}
