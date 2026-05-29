/** AX.5 — Campaign builder (Amazon-style: choose type → configure). */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { CreateCampaignClient } from './CreateCampaignClient'

export const metadata: Metadata = { title: 'Amazon Ads · Create campaign' }
export const dynamic = 'force-dynamic'

export default function CreateCampaignPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <CreateCampaignClient />
    </div>
  )
}
