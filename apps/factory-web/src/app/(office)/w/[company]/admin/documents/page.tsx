import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DocumentsPage } from '../../../../../../areas/admin/documents/DocumentsPage'

export const metadata: Metadata = { title: 'Documents & numbering · Nexus Factory' }

/**
 * Admin › Documents & numbering (SCR-014; areas/admin/nav.ts, numbering.view): the number series with the Fiscal check,
 * and the fixed document layouts. `?view=documents`, `?company=<id>`, `?series=<id>`, `?numbers=<id>`, `?new=series`.
 */
export default function Page() {
  return (
    <Suspense>
      <DocumentsPage />
    </Suspense>
  )
}
