/** AX.11 — N-gram search-term intelligence page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { NgramClient } from './NgramClient'

export const metadata: Metadata = { title: 'Amazon Ads · N-gram intelligence' }
export const dynamic = 'force-dynamic'

export default function NgramPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <NgramClient />
    </div>
  )
}
