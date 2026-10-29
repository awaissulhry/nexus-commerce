import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RolesPage } from '../../../../../../areas/admin/roles/RolesPage'

export const metadata: Metadata = { title: 'Roles & permissions · Nexus Factory' }

/** Admin › Roles & permissions (SCR-012; areas/admin/nav.ts, roles.view). */
export default function Page() {
  return (
    <Suspense>
      <RolesPage />
    </Suspense>
  )
}
