/** Ad Group Details route — drill-in from the campaign's Ad Groups grid. */
import { AdGroupDetail } from './AdGroupDetail'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AdGroupDetailPage({ params }: { params: Promise<{ id: string; agId: string }> }) {
  const { id, agId } = await params
  return <AdGroupDetail campaignId={id} adGroupId={agId} />
}
