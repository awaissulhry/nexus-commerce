/**
 * AX.6 — Keyword-paste auto-architect page.
 */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { ArchitectClient } from './ArchitectClient'

export const metadata: Metadata = { title: 'Amazon Ads · Auto-architect' }
export const dynamic = 'force-dynamic'

export default function ArchitectPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <ArchitectClient />
    </div>
  )
}
