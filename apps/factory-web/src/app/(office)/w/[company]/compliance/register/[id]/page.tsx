import { Suspense } from 'react'
import type { Metadata } from 'next'
import { EntryRecord } from '../../../../../../../areas/compliance/register/record/EntryRecord'

export const metadata: Metadata = { title: 'Register entry · Nexus Factory' }

/** Compliance › PPE register › an entry (SCR-113; `?tab=`). */
export default async function EntryRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <EntryRecord entryId={decodeURIComponent(id)} />
    </Suspense>
  )
}
