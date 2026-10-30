import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CertificateRecord } from '../../../../../../../areas/compliance/certificates/record/CertificateRecord'

export const metadata: Metadata = { title: 'Certificate · Nexus Factory' }

/** Compliance › Certificates › a certificate (SCR-051; `?tab=coverage|body|files|activity`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <CertificateRecord certificateId={decodeURIComponent(id)} />
    </Suspense>
  )
}
