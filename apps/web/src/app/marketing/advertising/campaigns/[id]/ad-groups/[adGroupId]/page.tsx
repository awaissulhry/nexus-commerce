/**
 * AME.6 — Ad-group detail page. Server-fetches the ad group (metrics derived
 * live from the daily table) and renders the Amazon-parity drill-down:
 * left nav (Ads / Targeting / Negative targeting / Search terms / Ad group
 * settings / History) + KPI chart header + ads table.
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdvertisingNav } from '../../../../_shared/AdvertisingNav'
import { AdGroupDetailCockpit, type AdGroupDetail } from './AdGroupDetailCockpit'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

async function fetchAdGroup(id: string): Promise<{ adGroup: AdGroupDetail } | null> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/ad-groups/${id}`, { cache: 'no-store' }).catch(() => null)
  if (!res || res.status === 404 || !res.ok) return null
  return (await res.json().catch(() => null)) as { adGroup: AdGroupDetail } | null
}

export async function generateMetadata({ params }: { params: Promise<{ adGroupId: string }> }): Promise<Metadata> {
  const { adGroupId } = await params
  const d = await fetchAdGroup(adGroupId)
  return { title: `${d?.adGroup?.name ?? 'Ad group'} · Amazon Ads` }
}

export default async function AdGroupDetailPage({ params }: { params: Promise<{ id: string; adGroupId: string }> }) {
  const { adGroupId } = await params
  const d = await fetchAdGroup(adGroupId)
  if (!d?.adGroup) notFound()
  return (
    <>
      <div className="px-4 pt-4"><AdvertisingNav /></div>
      <AdGroupDetailCockpit adGroup={d.adGroup} />
    </>
  )
}
