import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ImportPage } from '../../../../../../areas/admin/import/ImportPage'

export const metadata: Metadata = { title: 'Import & export · Nexus Factory' }

/** Admin › Import & export (SCR-017; areas/admin/nav.ts, imports.view). `?importer=<key>`, `?new=1`, `?job=<id>`. */
export default function Page() {
  return (
    <Suspense>
      <ImportPage />
    </Suspense>
  )
}
