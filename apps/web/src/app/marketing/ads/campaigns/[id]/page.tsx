/** CBN.3.1 — Campaign Details route (drill-in from the Ad Manager grid). */
import { CampaignDetail } from './CampaignDetail'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <CampaignDetail id={id} />
}
