import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ComplaintRecord } from '../../../../../../../areas/quality/complaints/record/ComplaintRecord'

export const metadata: Metadata = { title: 'Complaint · Nexus Factory' }

/** Quality › Complaints › a complaint (SCR-113 W2a part; `?tab=complaint|investigation|answer|linked`; the old `activity` opens Complaint with the thread — B-TH-266, `?do=ncr|register`). */
export default async function ComplaintRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ComplaintRecord complaintId={decodeURIComponent(id)} />
    </Suspense>
  )
}
