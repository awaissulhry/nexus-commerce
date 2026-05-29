/**
 * AX.7 — Negative + keyword harvesting page.
 */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { HarvestClient } from './HarvestClient'

export const metadata: Metadata = { title: 'Amazon Ads · Harvesting' }
export const dynamic = 'force-dynamic'

export default function HarvestPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <HarvestClient />
    </div>
  )
}
