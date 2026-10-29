import { Suspense } from 'react'
import type { Metadata } from 'next'
import { UserRecord } from '../../../../../../../areas/admin/users/record/UserRecord'

export const metadata: Metadata = { title: 'User · Nexus Factory' }

/** Admin › Users › an office person (SCR-011; `?tab=profile|roles|activity`). */
export default async function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params
  return (
    <Suspense>
      <UserRecord userId={decodeURIComponent(userId)} />
    </Suspense>
  )
}
