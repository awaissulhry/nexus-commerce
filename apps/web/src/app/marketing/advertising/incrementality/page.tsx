/** AX3.5 — iROAS / incrementality page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { IncrementalityClient } from './IncrementalityClient'

export const metadata: Metadata = { title: 'Amazon Ads · iROAS & incrementality' }
export const dynamic = 'force-dynamic'

export default function IncrementalityPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <IncrementalityClient />
    </div>
  )
}
