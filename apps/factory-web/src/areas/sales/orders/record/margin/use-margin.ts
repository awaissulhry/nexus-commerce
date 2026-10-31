'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { getOrderMargin, type OrderMargin } from '../../../../finance/margins/api'
import { marginsCanOf, readProblem, showsMargin } from '../../../../finance/margins/model'
import type { MarginTabModel } from './model'

/**
 * B-W2a-72 — the sales order's Margin tab reads the order's margin (`GET /costing/margins/orders/:id`, costing.view) when
 * the tab is open, again when the order changes (its version) and on Try again; nothing without costing.view or the
 * margin grain. The record's container calls it and hands the model to the view.
 */
export function useOrderMargin(api: ApiClient, orderId: string, open: boolean, permissions: readonly string[], version: number | null): { model: MarginTabModel; retry: () => void } {
  const can = useMemo(() => marginsCanOf(permissions), [permissions])
  const [part, setPart] = useState<{ value: OrderMargin | null; problem: string | null } | null>(null)
  const seq = useRef(0)
  const asks = open && showsMargin(can) && version !== null
  const read = useCallback(() => {
    const mine = ++seq.current
    setPart((current) => ({ value: current?.value ?? null, problem: null }))
    getOrderMargin(api, orderId)
      .then((value) => mine === seq.current && setPart({ value, problem: null }))
      .catch((error: unknown) => mine === seq.current && setPart({ value: null, problem: readProblem(error) }))
  }, [api, orderId])
  useEffect(() => {
    if (asks) read()
  }, [asks, read, version])
  return { model: { can, part: asks ? (part ?? { value: null, problem: null }) : null }, retry: read }
}
