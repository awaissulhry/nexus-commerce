// /marketing/reviews/inbox — Reviews › Inbox (build spec §3.2): every product review and seller feedback, on every
// channel and market, with the review pop-up and Import. The page is InboxClient: it reads the address on the client
// (tab, period, tiles, filters, `?import=1`, `?review=<id>`) and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InboxClient } from './InboxClient'
import ReviewsInboxLoading from './loading'

export const metadata: Metadata = { title: 'Reviews · Inbox' }

export default function ReviewsInboxPage() {
  return (
    <Suspense fallback={<ReviewsInboxLoading />}>
      <InboxClient />
    </Suspense>
  )
}
