import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { FunnelClient } from './FunnelClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Launch & keyword funnel · Amazon Ads' }

export default function FunnelPage() {
  return (
    <>
      <div className="px-4 pt-4"><AdvertisingNav /></div>
      <FunnelClient />
    </>
  )
}
