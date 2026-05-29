/** AX.9 — Dayparting schedules page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { DaypartingClient } from './DaypartingClient'

export const metadata: Metadata = { title: 'Amazon Ads · Dayparting' }
export const dynamic = 'force-dynamic'

export default function DaypartingPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <DaypartingClient />
    </div>
  )
}
