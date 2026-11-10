import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DeclarationRecord } from '../../../../../../../areas/compliance/declarations/record/DeclarationRecord'

export const metadata: Metadata = { title: 'Declaration · Nexus Factory' }

/** Compliance › Declarations & instructions › a declaration or a leaflet (SCR-052-record; `?tab=content|languages|batches|publication`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <DeclarationRecord documentId={decodeURIComponent(id)} />
    </Suspense>
  )
}
