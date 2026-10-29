import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ConnectionRecord } from '../../../../../../../areas/admin/connections/record/ConnectionRecord'

export const metadata: Metadata = { title: 'Connection · Nexus Factory' }

/** Admin › Connections & API › a connection (SCR-087 Connection record; `?tab=overview|settings|calls|inbound|activity`). */
export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params
  return (
    <Suspense>
      <ConnectionRecord accountId={decodeURIComponent(accountId)} />
    </Suspense>
  )
}
