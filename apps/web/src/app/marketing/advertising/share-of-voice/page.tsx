/** AX2.6 — Share of Voice + impression-share intelligence page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { SovClient } from './SovClient'

export const metadata: Metadata = { title: 'Amazon Ads · Share of voice' }
export const dynamic = 'force-dynamic'

export default function ShareOfVoicePage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <SovClient />
    </div>
  )
}
