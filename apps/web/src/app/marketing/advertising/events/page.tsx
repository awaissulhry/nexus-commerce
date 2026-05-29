/** AX3.14 — Advertising Events log page. */
import type { Metadata } from 'next'
import { EventsClient } from './EventsClient'

export const metadata: Metadata = { title: 'Amazon Ads · Events' }
export const dynamic = 'force-dynamic'

export default function EventsPage() {
  return (
    <div className="px-4 py-4">
      <EventsClient />
    </div>
  )
}
