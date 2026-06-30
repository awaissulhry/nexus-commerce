'use client'
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export interface AdGroupRow {
  id: string
  name: string
  status?: string | null
  spendCents?: number | null
  salesCents?: number | null
  acos?: number | string | null
  ordersCount?: number | null
}

/**
 * Lazily fetches a campaign's detail (ad groups) when a campaign node is selected.
 * Read-only. `localId` is the campaign's local id (the `c:` prefix already stripped),
 * or null for non-campaign selections.
 */
export function useCampaignDetail(localId: string | null): {
  adGroups: AdGroupRow[]
  ordersTotal: number | null
  loading: boolean
} {
  const [adGroups, setAdGroups] = useState<AdGroupRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!localId) {
      setAdGroups([])
      return
    }
    let alive = true
    setLoading(true)
    // windowDays=30 keeps the detail (ad-group) metrics on the SAME 30-day window
    // as the campaign node + header ("Last 30 days"); the detail endpoint otherwise
    // defaults to 7d, which made the breakdown look like it didn't reconcile.
    // TODO: track the global date-range selector once it's wired.
    fetch(`${getBackendUrl()}/api/advertising/campaigns/${localId}?windowDays=30`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setAdGroups((d?.campaign?.adGroups ?? []) as AdGroupRow[])
      })
      .catch(() => {
        if (alive) setAdGroups([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [localId])

  const ordersTotal = adGroups.length ? adGroups.reduce((s, a) => s + (Number(a.ordersCount) || 0), 0) : null
  return { adGroups, ordersTotal, loading }
}
