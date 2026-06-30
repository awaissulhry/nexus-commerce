'use client'
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignsToObjects, type ApiCampaign, type ApiPortfolio } from './accountGraph'
import type { OpsObject } from './types'

export function useAccountGraph(): { objects: OpsObject[]; loading: boolean; error: string | null } {
  const [objects, setObjects] = useState<OpsObject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const base = getBackendUrl()
        const [cr, pr] = await Promise.all([
          fetch(`${base}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }),
          fetch(`${base}/api/advertising/portfolios`, { cache: 'no-store' }).catch(() => null),
        ])
        const cd = await cr.json()
        const pd = pr && pr.ok ? await pr.json() : { portfolios: [] }
        if (!alive) return
        const campaigns = (cd.items ?? []) as ApiCampaign[]
        const portfolios = (pd.portfolios ?? []) as ApiPortfolio[]
        setObjects(campaignsToObjects(campaigns, portfolios))
        setError(null)
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? 'Failed to load account graph')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return { objects, loading, error }
}
