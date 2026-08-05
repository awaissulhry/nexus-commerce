/**
 * AME.17 — keyword-graduation funnel + cross-match negation launcher.
 *
 * ACR.6 (Stage 6): parked, not retired — same reason as the n-gram page next door. The standing
 * Reporting/Analytics split names "funnel" explicitly as Analytics' territory, and Analytics belongs
 * to another workstream.
 *
 * Note for whoever moves it: this page is two things. The journey view is interpretation and belongs
 * with the rest of Analytics, but `POST /advertising/funnel/cross-match` is an ACTION — it writes
 * negatives so one product stops bidding against itself across match types — and would sit naturally
 * on /marketing/ads/rules-automation?tab=negative-targeting. It may want splitting rather than
 * moving whole.
 */
import type { Metadata } from 'next'
import { FunnelClient } from './FunnelClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Launch & keyword funnel · Amazon Ads' }

export default function FunnelPage() {
  return <FunnelClient />
}
