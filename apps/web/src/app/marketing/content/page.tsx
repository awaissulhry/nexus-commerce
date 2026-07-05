'use client'

// MC.1.1 — DAM hub page shell.
//
// Replaces the W4.5/Phase-5 ComingSoonPage placeholder with the real
// /marketing/content surface. This commit lands the page shell:
// PageHeader, KPI strip (total assets / images / videos / storage /
// in-use / orphaned / needs-alt), and a toolbar scaffold that the
// MC.1.2–1.5 commits hang the library, filters, search, and detail
// drawer off of.
//
// The library list itself is intentionally an EmptyState placeholder
// in this commit — MC.1.2 (virtualized grid + list view) replaces it.
// Shipping the shell first keeps the diff readable + lets us verify
// the KPI strip + toolbar in isolation before introducing 10k-row
// virtualization.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the overview MUST load client-side
// where the fetch patch adds credentials. Server-side this page 401'd into
// zeroed KPIs for everyone.

import { useEffect, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import ContentHubClient from './ContentHubClient'
import type { OverviewPayload } from './_lib/types'

const EMPTY_OVERVIEW: OverviewPayload = {
  totalAssets: 0,
  productImageCount: 0,
  videoCount: 0,
  byType: {},
  storageBytes: 0,
  inUseCount: 0,
  orphanedCount: 0,
  needsAttention: { missingAltImages: 0 },
}

async function fetchOverview(): Promise<{
  data: OverviewPayload
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/assets/overview`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        data: EMPTY_OVERVIEW,
        error: `Overview API returned ${res.status}`,
      }
    }
    const data = (await res.json()) as OverviewPayload
    return { data, error: null }
  } catch (err) {
    return {
      data: EMPTY_OVERVIEW,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default function ContentHubPage() {
  const { t } = useTranslations()
  const [result, setResult] = useState<{
    data: OverviewPayload
    error: string | null
  } | null>(null)

  useEffect(() => {
    let alive = true
    fetchOverview().then((r) => {
      if (alive) setResult(r)
    })
    return () => {
      alive = false
    }
  }, [])

  const apiBase = getBackendUrl()

  if (!result) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('marketingContent.title')}
          description={t('marketingContent.description')}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-md border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800" />
      </div>
    )
  }

  return (
    <ContentHubClient
      overview={result.data}
      overviewError={result.error}
      apiBase={apiBase}
      icon={<ImageIcon className="w-5 h-5" />}
    />
  )
}
