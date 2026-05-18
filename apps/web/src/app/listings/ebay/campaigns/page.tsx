import type { Metadata } from 'next'
import EbayCampaignsClient from './EbayCampaignsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: 'eBay Promoted Listings · Campaigns' }

export default function EbayCampaignsPage() {
  return <EbayCampaignsClient />
}
