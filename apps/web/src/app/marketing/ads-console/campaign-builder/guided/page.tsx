/** Ads Console — Guided Campaign Builder (Adtomic / "Helium 10 Ads" match, CB-series). */
import type { Metadata } from 'next'
import { GuidedBuilder } from './GuidedBuilder'

export const metadata: Metadata = { title: 'Campaign Builder | Ads Console' }
export const dynamic = 'force-dynamic'

export default function GuidedCampaignBuilderPage() {
  return <GuidedBuilder />
}
