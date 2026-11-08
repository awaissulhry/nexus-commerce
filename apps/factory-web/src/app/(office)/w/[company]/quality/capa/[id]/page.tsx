import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CapaRecord } from '../../../../../../../areas/quality/capa/record/CapaRecord'

export const metadata: Metadata = { title: 'Corrective action · Nexus Factory' }

/** Quality › Corrective actions › a CAPA or an 8D (SCR-146-record; `?tab=problem|actions|report|activity`). */
export default async function CapaRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <CapaRecord capaId={decodeURIComponent(id)} />
    </Suspense>
  )
}
