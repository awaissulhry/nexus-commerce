/** ER1 — routed ad-group drill-down (C4), mirroring Amazon's AdGroupDetail. */
import { EbayAdGroupDetail } from './EbayAdGroupDetail'

export default async function Page({ params }: { params: Promise<{ id: string; agId: string }> }) {
  const { id, agId } = await params
  return <EbayAdGroupDetail campaignId={id} adGroupId={agId} />
}
