'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { readProblem } from '../../model'
import { getOrderProduction, type ProductionPart } from './api'
import { mergeRead, type ProductionState } from './model'

/**
 * F-SA-232 — the order page's production read (OR1, `GET /sales/orders/:orderId/production`): every part on arrival (the band's health
 * and Overview need it at once), then only the parts a live event touched (`again(parts)`, F-SA-239), merged into what the page holds
 * — a part re-read never blanks the others, and a failed re-read keeps the last good figures (said by the freshness line). One read at
 * a time per part set; an answer of an older read never replaces a newer one.
 */
export function useOrderProduction(api: ApiClient, orderId: string | null, enabled = true): { readonly state: ProductionState | null; readonly again: (parts?: readonly ProductionPart[]) => void } {
  const [state, setState] = useState<ProductionState | null>(enabled && orderId ? { status: 'loading' } : null)
  const turn = useRef(0)
  const held = useRef<ProductionState | null>(state)
  held.current = state

  const read = useCallback(
    (parts?: readonly ProductionPart[]) => {
      if (!orderId) return
      const mine = ++turn.current
      const partial = !!parts && parts.length > 0
      if (!partial || held.current?.status !== 'ready') setState((known) => (known?.status === 'ready' && partial ? known : { status: 'loading' }))
      getOrderProduction(api, orderId, partial ? parts : undefined)
        .then((next) => {
          if (mine !== turn.current && !partial) return
          setState((known) => ({ status: 'ready', read: mergeRead(known?.status === 'ready' ? known.read : null, next) }))
        })
        .catch((error: unknown) => {
          if (mine !== turn.current) return
          // A failed re-read keeps the last good figures; a failed first read says so (this part only, with Try again).
          setState((known) => (known?.status === 'ready' ? known : { status: 'failed', problem: readProblem(error) }))
        })
    },
    [api, orderId],
  )

  useEffect(() => {
    if (!enabled || !orderId) {
      setState(null)
      return
    }
    read()
  }, [enabled, orderId, read])

  return { state, again: read }
}
