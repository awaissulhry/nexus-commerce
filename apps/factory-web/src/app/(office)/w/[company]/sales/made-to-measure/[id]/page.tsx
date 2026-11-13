import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ProfileRecord } from '../../../../../../../areas/sales/mtm/record/ProfileRecord'

export const metadata: Metadata = { title: 'Rider profile · Nexus Factory' }

/** Sales › Made-to-measure › a rider profile (SCR-036-record; `?tab=measurements|photos|fittings|proofs|orders|activity`, `&do=` a row verb's dialog). */
export default async function RiderProfileRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ProfileRecord profileId={decodeURIComponent(id)} />
    </Suspense>
  )
}
