import { Suspense } from 'react'
import type { Metadata } from 'next'
import { UsersPage } from '../../../../../../areas/admin/users/UsersPage'

export const metadata: Metadata = { title: 'Users · Nexus Factory' }

/** Admin › Users (SCR-010; areas/admin/nav.ts, users.view). `?audience=floor` opens the floor workers. */
export default function Page() {
  return (
    <Suspense>
      <UsersPage />
    </Suspense>
  )
}
