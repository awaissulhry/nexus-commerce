import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ConnectionsPage } from '../../../../../../areas/admin/connections/ConnectionsPage'

export const metadata: Metadata = { title: 'Connections & API · Nexus Factory' }

/** Admin › Connections & API (SCR-087 with the mail domain, SCR-015; areas/admin/nav.ts, integrations.view). `#mail`. */
export default function Page() {
  return (
    <Suspense>
      <ConnectionsPage />
    </Suspense>
  )
}
