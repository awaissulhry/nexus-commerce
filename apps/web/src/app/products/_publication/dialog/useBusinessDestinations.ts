'use client'

/**
 * The destinations a business can publish to, for a surface without a product studio (the products list).
 *
 * Reads the same two sources the studio frame reads — `GET /api/marketplaces/grouped` and `GET /api/connections?all=true`
 * — and joins them with the studio's own rule (`joinMarketplaceConnections` in `studio-data.ts`): a market is reachable
 * through each of its channel's accounts, and it counts as connected when one of them is healthy. The dialog then lists
 * one option per market × account.
 */
import { useEffect, useState } from 'react'
import { joinMarketplaceConnections } from '@/app/products/[id]/edit/_studio/studio-data'
import { flattenGrouped } from '@/app/products/[id]/edit/_studio/scopes'
import { publicationDestinations, type PublicationDestinationOption, type PublicationMarket } from './model'
import { publicationRequest as request } from './request'

export interface BusinessDestinations {
  destinations: PublicationDestinationOption[]
  loading: boolean
  /** The markets or the connected accounts could not be read; the list is then not trustworthy. */
  failed: boolean
}

/**
 * The studio's join (`joinMarketplaceConnections`), with one difference: the products list offers only the healthy
 * accounts of a market, because a many-product check would refuse every row of an unhealthy one.
 */
export function joinMarketsAndConnections(grouped: unknown, connections: unknown, now: number = Date.now()): PublicationMarket[] {
  return joinMarketplaceConnections(flattenGrouped(grouped), connections, now)
    .map(m => ({ ...m, accounts: (m.accounts ?? []).filter(a => a.health?.state === 'connected') }))
}

export function useBusinessDestinations(enabled: boolean): BusinessDestinations {
  const [state, setState] = useState<BusinessDestinations>({ destinations: [], loading: enabled, failed: false })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setState(prev => ({ ...prev, loading: true, failed: false }))
    void Promise.all([
      request<unknown>('/api/marketplaces/grouped', 'GET', undefined, controller.signal),
      request<unknown>('/api/connections?all=true', 'GET', undefined, controller.signal),
    ]).then(([grouped, connections]) => {
      if (controller.signal.aborted) return
      setState({ destinations: publicationDestinations(joinMarketsAndConnections(grouped, connections)), loading: false, failed: false })
    }).catch(() => { if (!controller.signal.aborted) setState({ destinations: [], loading: false, failed: true }) })
    return () => controller.abort()
  }, [enabled])
  return state
}
