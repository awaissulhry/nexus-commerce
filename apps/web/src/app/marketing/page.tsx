'use client'

// MC.14.6 — Marketing landing dashboard.
//
// Aggregates the cross-surface KPIs (DAM totals, A+ Content count,
// Brand Story count, Brand Kit count, automation rule fires this
// week, recent publishes) into a single page so the operator has a
// clear "what's the state of marketing" answer at /marketing
// instead of the bare nav-redirect that used to live here.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetches 401'd
// and everyone saw zeroed KPIs in prod. Data MUST load client-side where
// the patched window.fetch adds credentials.

import { useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import MarketingDashboardClient from './MarketingDashboardClient'

interface OverviewPayload {
  totalAssets: number
  productImageCount: number
  videoCount: number
  storageBytes: number
}

interface Stats {
  assets: number
  videos: number
  storageBytes: number
  aplusCount: number
  brandStoryCount: number
  brandKitCount: number
  automationCount: number
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

async function fetchStats(): Promise<Stats> {
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

  return {
    assets: overview.totalAssets + overview.productImageCount,
    videos: overview.videoCount,
    storageBytes: overview.storageBytes,
    aplusCount: aplusList.items.length,
    brandStoryCount: brandStoryList.items.length,
    brandKitCount: brandKitList.kits.length,
    automationCount: automation.rules.length,
  }
}

export default function MarketingDashboardPage() {
  const { t } = useTranslations()
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    let alive = true
    fetchStats().then((s) => {
      if (alive) setStats(s)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!stats) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('marketingHome.title')}
          description={t('marketingHome.description')}
        />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
        <div className="h-40 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      </div>
    )
  }

  return (
    <MarketingDashboardClient
      icon={<ImageIcon className="w-5 h-5" />}
      stats={stats}
    />
  )
}
