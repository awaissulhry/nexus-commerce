'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { readProblem } from '../../model'
import { PART_LOADING, type Part } from '../record-model'
import { listOrderIssues, type OrderIssues } from './api'

/**
 * F-PT-103 (order PRODUCTION tab) — the order's asks, the container's part (OrderRecord.tsx mounts it; a view never imports it): read
 * while Production shows (orders.view: the API checks the order first), again when the page says so (a note sent, the `quality` part
 * of a live event: production_issue.*). A re-read keeps what is drawn until it answers (nothing jumps); a failed re-read keeps the last
 * answer, a failed first read says so (with its own Try again). Another order: nothing of the last one is kept.
 */
export function useOrderAsks(api: ApiClient, orderId: string | null, enabled: boolean): { readonly state: Part<OrderIssues> | null; readonly again: () => void } {
  const [state, setState] = useState<Part<OrderIssues> | null>(null)
  const turn = useRef(0)
  const read = useCallback(() => {
    if (!orderId || !enabled) return
    const mine = ++turn.current
    setState((known) => known ?? PART_LOADING)
    listOrderIssues(api, orderId)
      .then((value) => mine === turn.current && setState({ value, problem: null }))
      .catch((error: unknown) => mine === turn.current && setState((known) => (known?.value ? known : { value: null, problem: readProblem(error) })))
  }, [api, orderId, enabled])
  useEffect(() => {
    turn.current++
    setState(null)
  }, [orderId])
  useEffect(() => read(), [read])
  return { state: enabled ? state : null, again: read }
}
