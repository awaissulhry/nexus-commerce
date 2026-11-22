'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { getOrderMargin, type OrderMargin } from '../../../../finance/margins/api'
import { marginsCanOf, showsMargin } from '../../../../finance/margins/model'
// om-fx1 #2 (F-OM-302): the read failed — in the order page's words (Money's Margin section says it with the kit's own PartFailed).
import { readProblem } from '../../model'
import type { MarginTabModel } from './model'
import { useLive } from '../../hooks' // F-OM-302 (B-OM-021): the margin changed by hand elsewhere reads it again

/** F-OM-302 (B-OM-021): the live event of an order's margin changed by hand (factory-domain costing/events.ts). */
export const MARGIN_EVENT = 'order_margin.changed'

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
  // F-OM-302 (B-OM-021, B-OM-008): a cost line set by hand or the target changed (here, in Finance, by another person): read again.
  useLive(
    (change) => {
      if (change.type === MARGIN_EVENT && change.fields.orderId === orderId) read()
    },
    () => read(),
    asks,
  )
  return { model: { can, part: asks ? (part ?? { value: null, problem: null }) : null }, retry: read }
}
