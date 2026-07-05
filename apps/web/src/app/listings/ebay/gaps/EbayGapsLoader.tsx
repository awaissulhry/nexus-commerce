'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side gap/progress
// fetches 401'd and everyone saw an empty gap analysis in prod. Data MUST
// load client-side where the patched window.fetch adds credentials.
//
// page.tsx keeps generateMetadata (server-only), so the data loading lives
// in this sibling client component instead.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { COUNTRY_NAMES } from '@/lib/country-names'
import PageHeader from '@/components/layout/PageHeader'
import EbayGapsClient from './EbayGapsClient'

interface LoadedData {
  gap: any
  progress: any
}

export default function EbayGapsLoader({ marketplace }: { marketplace: string }) {
  const [data, setData] = useState<LoadedData | null>(null)

  useEffect(() => {
    let alive = true
    setData(null)
    ;(async () => {
      const backend = getBackendUrl()
      const [gapRes, progressRes] = await Promise.all([
        fetch(`${backend}/api/ebay/phase3/gap?marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
        fetch(`${backend}/api/ebay/phase3/progress?marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
      ])
      const gap = gapRes?.ok ? await gapRes.json().catch(() => null) : null
      const progress = progressRes?.ok ? await progressRes.json().catch(() => null) : null
      if (alive) setData({ gap, progress })
    })()
    return () => {
      alive = false
    }
  }, [marketplace])

  if (!data) {
    const marketLabel = COUNTRY_NAMES[marketplace] ?? marketplace
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={`eBay Listing Gaps · ${marketLabel}`}
          description={`Products active in Nexus with no eBay listing for ${marketLabel}. Select products and schedule bulk listing creation.`}
          breadcrumbs={[
            { label: 'Listings', href: '/listings' },
            { label: 'eBay', href: '/listings/ebay' },
            { label: `Gaps · ${marketLabel}` },
          ]}
        />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
        <div className="h-72 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      </div>
    )
  }

  return (
    <EbayGapsClient
      marketplace={marketplace}
      initialGap={data.gap}
      initialProgress={data.progress}
    />
  )
}
