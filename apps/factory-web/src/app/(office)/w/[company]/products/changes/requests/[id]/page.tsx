import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ChangeRecord } from '../../../../../../../../areas/products/changes/record/ChangeRecord'

export const metadata: Metadata = { title: 'Change request · Nexus Factory' }

/** Products › Changes & versions › a change request (SCR-117-record; `?tab=change|impact|approvals|affected|activity`). */
export default async function ChangeRequestRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ChangeRecord kind="request" id={decodeURIComponent(id)} />
    </Suspense>
  )
}
