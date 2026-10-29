import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RoleRecord } from '../../../../../../../areas/admin/roles/RoleRecord'

export const metadata: Metadata = { title: 'Role · Nexus Factory' }

/** Admin › Roles & permissions › a role (SCR-012 Role record; `?tab=permissions|rules|users|activity`). */
export default async function Page({ params }: { params: Promise<{ roleId: string }> }) {
  const { roleId } = await params
  return (
    <Suspense>
      <RoleRecord roleId={decodeURIComponent(roleId)} />
    </Suspense>
  )
}
