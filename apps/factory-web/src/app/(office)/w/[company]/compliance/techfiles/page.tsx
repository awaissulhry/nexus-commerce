import { Suspense } from 'react'
import type { Metadata } from 'next'
import { TechFilesPage } from '../../../../../../areas/compliance/techfiles/TechFilesPage'

export const metadata: Metadata = { title: 'Technical files · Nexus Factory' }

/**
 * Compliance › Technical files (SCR-120; compliance.certificates.view): one Annex III technical file per certified style, its
 * tiles and grid. `?tile=` names a saved filter, `?status=` and `?q=` filter, `?new=1` opens New technical file, `?pack=<file>`
 * Build evidence pack.
 */
export default function Page() {
  return (
    <Suspense>
      <TechFilesPage />
    </Suspense>
  )
}
