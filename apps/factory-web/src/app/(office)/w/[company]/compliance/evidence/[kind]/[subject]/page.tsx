import { Suspense } from 'react'
import type { Metadata } from 'next'
import { EvidenceTrail } from '../../../../../../../../areas/quality/evidence/EvidenceTrail'

export const metadata: Metadata = { title: 'Evidence trail · Nexus Factory' }

/**
 * The evidence trail of a garment serial or a batch (design compliance.techfiles#evidence-trail; Owner answer Q2 (a):
 * read only in W1; the PDF pack and the authority link are W2b). Opened in a new tab from an inspection, a release, a
 * register entry or a lot: `/compliance/evidence/batch/<batch number>` or `/compliance/evidence/serial/<serial>`.
 */
export default async function EvidenceRoute({ params }: { params: Promise<{ kind: string; subject: string }> }) {
  const { kind, subject } = await params
  return (
    <Suspense>
      <EvidenceTrail kind={decodeURIComponent(kind)} subject={decodeURIComponent(subject)} />
    </Suspense>
  )
}
