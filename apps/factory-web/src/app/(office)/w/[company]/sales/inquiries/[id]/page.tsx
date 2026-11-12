import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InquiryRecord } from '../../../../../../../areas/sales/inquiries/record/InquiryRecord'

export const metadata: Metadata = { title: 'Inquiry · Nexus Factory' }

/** Sales › Inquiries › an inquiry's full page (design tab:inquiries.full; `?tab=request|files|quote|activity`). */
export default async function InquiryRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <InquiryRecord inquiryId={decodeURIComponent(id)} />
    </Suspense>
  )
}
