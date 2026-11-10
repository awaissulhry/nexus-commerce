import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DeclarationsPage } from '../../../../../../areas/compliance/declarations/DeclarationsPage'

export const metadata: Metadata = { title: 'Declarations & instructions · Nexus Factory' }

/**
 * Compliance › Declarations & instructions (SCR-052; areas/compliance/nav.ts, permission compliance.certificates.view): every DoC
 * and user-information leaflet per style, language and revision, the language coverage, New declaration, Language check. The
 * client container reads `?kind=`, `?status=`, `?origin=`, `?language=`, `?q=`, `?gaps=`, `?new=`, `?style=`, `?newKind=`,
 * `?lang=`, `?check=`, `?unrecorded=`.
 */
export default function DeclarationsRoute() {
  return (
    <Suspense>
      <DeclarationsPage />
    </Suspense>
  )
}
