'use client'

// MC.10.1 — Brand Kit list page.
//
// Shows every BrandKit + every catalogue brand without a kit yet,
// so the operator can spin up a kit for a brand they already sell.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetches 401'd
// and everyone saw "Brand-kit API returned 401" + an empty list in prod.
// Data MUST load client-side where the patched window.fetch adds
// credentials.

import { useEffect, useState } from 'react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import BrandKitListClient from './BrandKitListClient'
import type { BrandKitRow, BrandMetaRow } from './_lib/types'

interface LoadedData {
  kits: BrandKitRow[]
  brands: BrandMetaRow[]
  error: string | null
}

async function fetchData(): Promise<LoadedData> {
  const backend = getBackendUrl()
  try {
    const [kitsRes, brandsRes] = await Promise.all([
      fetch(`${backend}/api/brand-kits`, { cache: 'no-store' }),
      fetch(`${backend}/api/brand-kits/_meta/brands`, { cache: 'no-store' }),
    ])
    if (!kitsRes.ok)
      return {
        kits: [],
        brands: [],
        error: `Brand-kit API returned ${kitsRes.status}`,
      }
    const kitsBody = (await kitsRes.json()) as { kits: BrandKitRow[] }
    const brandsBody = brandsRes.ok
      ? ((await brandsRes.json()) as { brands: BrandMetaRow[] })
      : { brands: [] }
    return { kits: kitsBody.kits, brands: brandsBody.brands, error: null }
  } catch (err) {
    return {
      kits: [],
      brands: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default function BrandKitListPage() {
  const { t } = useTranslations()
  const [data, setData] = useState<LoadedData | null>(null)

  useEffect(() => {
    let alive = true
    fetchData().then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('brandKit.title')}
          description={t('brandKit.description')}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <BrandKitListClient
      kits={data.kits}
      brands={data.brands}
      error={data.error}
      apiBase={getBackendUrl()}
    />
  )
}
