/**
 * AX.11 — N-gram search-term intelligence.
 *
 * ACR.6 (Stage 6): parked, not retired. The rest of /marketing/advertising 308s into
 * /marketing/ads; this page does not, because a standing operator decision (2026-08-04, recorded in
 * the Reporting client) assigns interpretation — coverage, funnel, n-grams, momentum — to Analytics,
 * and that page belongs to another workstream. Filing it under Reporting to close the tree faster
 * would have contradicted a decision rather than respected a boundary.
 *
 * It reads the 9,746 stored search terms, so there is real work here for whoever moves it.
 */
import type { Metadata } from 'next'
import { NgramClient } from './NgramClient'

export const metadata: Metadata = { title: 'Amazon Ads · N-gram intelligence' }
export const dynamic = 'force-dynamic'

export default function NgramPage() {
  return (
    <div className="px-4 py-4">
      <NgramClient />
    </div>
  )
}
