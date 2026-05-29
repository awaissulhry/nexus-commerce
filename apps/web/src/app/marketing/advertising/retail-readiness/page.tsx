/** AX3.1 — Retail-readiness guard page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { RetailReadinessClient } from './RetailReadinessClient'

export const metadata: Metadata = { title: 'Amazon Ads · Retail readiness' }
export const dynamic = 'force-dynamic'

export default function RetailReadinessPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <RetailReadinessClient />
    </div>
  )
}
