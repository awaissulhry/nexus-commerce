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
    fetch(`${getBackendUrl()}/api/advertising/campaigns/${localId}`, { cache: 'no-store' })
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
