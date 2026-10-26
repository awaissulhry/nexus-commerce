// /marketing/reviews/requests — Reviews › Requests › Queue (build spec §3.3a). The page is QueueClient: it reads the
// address on the client (filters, sort, page, the open request, `?inserts=1` / `?preview=1`) and renders its own
// PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { QueueClient } from './_queue/QueueClient'
import RequestsQueueLoading from './loading'

export const metadata: Metadata = { title: 'Reviews · Requests' }

export default function RequestsQueuePage() {
  return (
    <Suspense fallback={<RequestsQueueLoading />}>
      <QueueClient />
    </Suspense>
  )
}
