'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useAskToBuy } from '../../../../purchasing/requests/ask/AskToBuy'
import { listAsked } from '../../../../purchasing/requests/ask/api'
import type { ShortageLine } from '../../../../purchasing/requests/ask/model'
import { askKeyOf } from './materials'

/**
 * F-PT-304 (order PRODUCTION tab, 10-design §8) — Ask the buyers…, the container's part: the Material plan's own from-shortage dialog
 * (purchasing/requests/ask useAskToBuy — never a copy), only with purchasing.requests.ask and planning.view (the from-shortage route
 * needs both; hidden otherwise, L9), and the asks already made for this order's work orders ("Asked 20 Nov"): the live SHORTAGE
 * requests of their sites, read while Production shows and again after an ask.
 */
export function useAskBuyers(input: {
  readonly api: ApiClient
  readonly prefix: string
  readonly permissions: readonly string[]
  readonly enabled: boolean
  /** This order's work orders and their sites (the order read's chain). */
  readonly workOrders: readonly { readonly id: string; readonly siteId: string }[]
}): { readonly model: { readonly element: ReactNode; readonly asked: ReadonlyMap<string, string> } | null; readonly open: (line: ShortageLine) => void } {
  const { api, prefix, permissions, enabled, workOrders } = input
  const [asked, setAsked] = useState<ReadonlyMap<string, string>>(new Map())
  const [tick, setTick] = useState(0)
  const ask = useAskToBuy({ api, prefix, permissions, onAsked: () => setTick((count) => count + 1) })
  const may = ask.can.ask && permissions.includes('planning.view')
  const ids = workOrders.map((row) => row.id).join(',')
  const sites = [...new Set(workOrders.map((row) => row.siteId))].join(',')
  const turn = useRef(0)
  useEffect(() => {
    if (!may || !enabled || sites === '') return
    const mine = ++turn.current
    const own = new Set(ids.split(','))
    Promise.all(sites.split(',').map((siteId) => listAsked(api, { siteId, source: 'SHORTAGE', status: 'LIVE', limit: 200 }).catch(() => null)))
      .then((pages) => {
        if (mine !== turn.current) return
        const next = new Map<string, string>()
        for (const page of pages)
          for (const request of page?.requests ?? [])
            if (request.workOrder && own.has(request.workOrder.id) && request.item) next.set(askKeyOf(request.workOrder.id, request.item.id, request.colour?.id ?? null), request.requestedAt)
        setAsked(next)
      })
      .catch(() => undefined)
  }, [api, may, enabled, ids, sites, tick])
  const open = useCallback((line: ShortageLine) => ask.open(line), [ask])
  return { model: may ? { element: ask.element, asked } : null, open }
}
