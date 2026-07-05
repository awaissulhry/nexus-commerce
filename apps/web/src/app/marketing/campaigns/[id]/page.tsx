/**
 * UM-series (P3 completion) — campaign detail / builder.
 *
 * Capability-aware detail for any channel: header + metrics, channel-
 * specific detail (Amazon ad-product / eBay funding / discount / etc.),
 * per-market links, targets, and the CampaignAction audit trail. Pause/
 * resume + budget edit inline (sandbox-gated, same as the roster).
 *
 * Data loads client-side (CampaignDetailLoader): the API session cookie
 * lives on the API origin (cross-site), so server-side fetches can never
 * authenticate. page.tsx stays a server component for the metadata export.
 */

import type { Metadata } from 'next'
import { CampaignDetailLoader } from './CampaignDetailLoader'

export const metadata: Metadata = { title: 'Marketing · Campaign' }
export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <CampaignDetailLoader id={id} />
}
