import { Suspense } from 'react'
import type { Metadata } from 'next'
import { TechFileRecord } from '../../../../../../../areas/compliance/techfiles/record/TechFileRecord'

export const metadata: Metadata = { title: 'Technical file · Nexus Factory' }

/** Compliance › Technical files › a technical file (SCR-120-file; `?tab=annex|risk|tests|production|pack`; the old `activity` opens the Annex III checklist with the thread — B-TH-267, `?rev=`, `?share=`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <TechFileRecord fileId={decodeURIComponent(id)} />
    </Suspense>
  )
}
