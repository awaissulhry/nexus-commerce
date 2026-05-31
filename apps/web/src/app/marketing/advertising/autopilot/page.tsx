/** Apex F.3 — Autopilot cockpit: pick a north star, preview the plain-language plan, apply. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { AutopilotClient } from './AutopilotClient'

export const metadata: Metadata = { title: 'Amazon Ads · Autopilot' }
export const dynamic = 'force-dynamic'

export default function AutopilotPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <AutopilotClient />
    </div>
  )
}
