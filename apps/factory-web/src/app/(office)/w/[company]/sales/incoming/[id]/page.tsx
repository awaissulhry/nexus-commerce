import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InquiryRecord } from '../../../../../../../areas/sales/inquiries/record/InquiryRecord'

export const metadata: Metadata = { title: 'Request · Nexus Factory' }

/**
 * Sales › Incoming › a request's full page (design tab:inquiries.full; `?tab=request|files|quote|activity`). B-TH-216: the page
 * moved with the rename; the old /sales/inquiries/<id> redirects here with its query (next.config.ts, shell/nav/renamed.ts).
 */
export default async function RequestRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InquiryRecord inquiryId={decodeURIComponent(id)} />
    </Suspense>
  )
}
