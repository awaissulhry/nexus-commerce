// MC.14.6 — Marketing landing dashboard.
//
// Aggregates the cross-surface KPIs (DAM totals, A+ Content count,
// Brand Story count, Brand Kit count, automation rule fires this
// week, recent publishes) into a single page so the operator has a
// clear "what's the state of marketing" answer at /marketing
// instead of the bare nav-redirect that used to live here.

import { ImageIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import MarketingDashboardClient from './MarketingDashboardClient'

export const dynamic = 'force-dynamic'

interface OverviewPayload {
  totalAssets: number
  productImageCount: number
  videoCount: number
  storageBytes: number
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default async function MarketingDashboardPage() {
  const backend = getBackendUrl()

  const [overview, aplusList, brandStoryList, brandKitList, automation] =
    await Promise.all([
      fetchJson<OverviewPayload>(`${backend}/api/assets/overview`, {
        totalAssets: 0,
        productImageCount: 0,
        videoCount: 0,
        storageBytes: 0,
      }),
      fetchJson<{ items: unknown[] }>(`${backend}/api/aplus-content`, {
        items: [],
      }),
      fetchJson<{ items: unknown[] }>(`${backend}/api/brand-stories`, {
        items: [],
      }),
      fetchJson<{ kits: unknown[] }>(
        `${backend}/api/brand-kits`,
        { kits: [] },
      ),
      fetchJson<{ rules: unknown[] }>(
        `${backend}/api/marketing-automation/rules`,
        { rules: [] },
      ),
    ])

  return (
    <MarketingDashboardClient
      icon={<ImageIcon className="w-5 h-5" />}
      stats={{
        assets: overview.totalAssets + overview.productImageCount,
        videos: overview.videoCount,
        storageBytes: overview.storageBytes,
        aplusCount: aplusList.items.length,
        brandStoryCount: brandStoryList.items.length,
        brandKitCount: brandKitList.kits.length,
        automationCount: automation.rules.length,
      }}
    />
  )
}
