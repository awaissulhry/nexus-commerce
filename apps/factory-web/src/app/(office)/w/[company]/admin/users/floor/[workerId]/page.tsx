import { Suspense } from 'react'
import type { Metadata } from 'next'
import { WorkerRecord } from '../../../../../../../../areas/admin/users/record/WorkerRecord'

export const metadata: Metadata = { title: 'Floor worker · Nexus Factory' }

/** Admin › Users › a floor worker (SCR-011 floor; `?tab=profile|badge|activity`). */
export default async function Page({ params }: { params: Promise<{ workerId: string }> }) {
  const { workerId } = await params
  return (
    <Suspense>
      <WorkerRecord workerId={decodeURIComponent(workerId)} />
    </Suspense>
  )
}
