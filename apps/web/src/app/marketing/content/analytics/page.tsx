'use client'

// MC.13.5 — Storage analytics dashboard.
//
// Fetches the analytics snapshot from /api/assets/analytics (MC.13.4) +
// the workspace storage quota from /api/assets/overview (MC.13.1) and
// renders the operator-facing visual breakdown:
//
//   - KPI strip (total / orphaned / avg size / cloudinary deletes)
//   - Storage usage bar (used vs hard cap when set)
//   - Type breakdown (image / video / doc / etc.)
//   - Format breakdown (jpg / webp / mp4 / ...)
//   - Top 10 most-used assets
//   - Upload volume tiles (7 / 30 / 90 day)
//
// The page is read-only — operators land here from the Hub via a
// "View analytics" entry point in MC.13.5-followup.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side this page 401'd into the
// "Analytics unavailable" alert for everyone.

import { useEffect, useState } from 'react'
import { ImageIcon, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import StorageAnalyticsClient from './StorageAnalyticsClient'
import type { OverviewPayload } from '../_lib/types'

interface AnalyticsPayload {
  totalAssets: number
  averageBytes: number
  orphanedCount: number
  cloudinaryDeletes: number
  topUsed: Array<{
    id: string
    label: string
    url: string
    type: string
    usageCount: number
  }>
  typeBreakdown: Array<{ type: string; count: number; bytes: number }>
  formatBreakdown: Array<{ format: string; count: number }>
  uploadVolume: {
    last7Days: number
    last30Days: number
    last90Days: number
  }
}

async function fetchAnalytics(): Promise<{
  data: AnalyticsPayload | null
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/assets/analytics`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return { data: null, error: `Analytics API returned ${res.status}` }
    }
    return { data: (await res.json()) as AnalyticsPayload, error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

async function fetchOverview(): Promise<OverviewPayload | null> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/assets/overview`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as OverviewPayload
  } catch {
    return null
  }
}

export default function StorageAnalyticsPage() {
  const { t } = useTranslations()
  const [result, setResult] = useState<{
    data: AnalyticsPayload | null
    error: string | null
    overview: OverviewPayload | null
  } | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchAnalytics(), fetchOverview()]).then(
      ([{ data, error }, overview]) => {
        if (alive) setResult({ data, error, overview })
      },
    )
    return () => {
      alive = false
    }
  }, [])

  if (!result) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('marketingAnalytics.title')}
          description={t('marketingAnalytics.description')}
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800" />
      </div>
    )
  }

  const { data, error, overview } = result

  if (error || !data) {
    return (
      <div className="space-y-4 p-4">
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Analytics unavailable</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <StorageAnalyticsClient
      analytics={data}
      overview={overview}
      icon={<ImageIcon className="w-5 h-5" />}
    />
  )
}
