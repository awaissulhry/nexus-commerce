'use client'

/**
 * /reconciliation — client-side initial-data loader.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the stats + first page of rows MUST
 * load client-side where the fetch patch adds credentials. Server-side
 * these fetches 401'd into null stats/items for everyone.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import ReconciliationClient from './ReconciliationClient'

async function fetchInitialData(channel: string, marketplace: string) {
  const backend = getBackendUrl()
  const base = `${backend}/api/reconciliation`

  const [statsRes, itemsRes] = await Promise.all([
    fetch(`${base}/stats?channel=${channel}&marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
    fetch(`${base}/items?channel=${channel}&marketplace=${marketplace}&status=PENDING&pageSize=100`, { cache: 'no-store' }).catch(() => null),
  ])

  const stats = statsRes?.ok ? await statsRes.json().catch(() => null) : null
  const items = itemsRes?.ok ? await itemsRes.json().catch(() => null) : null

  return { stats, items }
}

export default function ReconciliationLoader({
  channel,
  marketplace,
}: {
  channel: string
  marketplace: string
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<{ stats: any; items: any } | null>(null)

  useEffect(() => {
    let alive = true
    setData(null)
    fetchInitialData(channel, marketplace).then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [channel, marketplace])

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50" aria-busy="true">
        <div className="bg-white border-b px-6 pt-4 pb-4">
          <h1 className="text-xl font-semibold text-gray-900">Listing Reconciliation</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Match, pull, and propagate Amazon listing data across all markets.
          </p>
        </div>
        <div className="px-6 py-4 max-w-screen-xl mx-auto space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-md border border-gray-200 bg-gray-100 animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-md border border-gray-200 bg-gray-100 animate-pulse" />
        </div>
      </div>
    )
  }

  return (
    <ReconciliationClient
      channel={channel}
      marketplace={marketplace}
      initialStats={data.stats}
      initialItems={data.items}
    />
  )
}
