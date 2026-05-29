/** AX3.4 — AMC-style audiences page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { AudiencesClient } from './AudiencesClient'

export const metadata: Metadata = { title: 'Amazon Ads · Audiences' }
export const dynamic = 'force-dynamic'

export default function AudiencesPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <AudiencesClient />
    </div>
  )
}
