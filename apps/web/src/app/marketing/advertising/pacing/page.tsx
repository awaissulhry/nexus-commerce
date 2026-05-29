/** AX.10 — Budget pacing page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { PacingClient } from './PacingClient'

export const metadata: Metadata = { title: 'Amazon Ads · Budget pacing' }
export const dynamic = 'force-dynamic'

export default function PacingPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <PacingClient />
    </div>
  )
}
