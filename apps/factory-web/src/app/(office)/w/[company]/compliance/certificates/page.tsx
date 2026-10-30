import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CertificatesPage } from '../../../../../../areas/compliance/certificates/CertificatesPage'

export const metadata: Metadata = { title: 'Certificates · Nexus Factory' }

/**
 * Compliance › Certificates (SCR-050; compliance.certificates.view): the EN 17092 garment and EN 1621 protector
 * certificates with their coverage and validity. `?view=` names a saved filter; `?new=1` opens Add certificate.
 */
export default function Page() {
  return (
    <Suspense>
      <CertificatesPage />
    </Suspense>
  )
}
