'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { WorkOrder } from '../../_shared/api'
import { getRecuts, recutDone, type Replacement } from '../../cutting/api'
import { cuttingCanOf, readProblem, writeProblem, type CuttingCan, type Part, type Phrase } from '../../cutting/model'
import { listCutOrders } from '../../cutting/orders/api'
import { cutOrdersOf, cutOrdersQuery, type CutOrderOfWorkOrder } from './model'

/**
 * F-PR-06 — what the Cut record read beside the work order's own parts, now on its Cutting & bundles tab: the recuts asked for
 * scrapped pieces (`GET /production/replacements?workOrderId=`, production.scrap.view) with Mark cut (production.scrap, by a cut
 * log entry of its cell), and the cut orders that cut for this work order (`GET /production/cut-orders?q=<its number>`,
 * production.cutting.view; only those naming its id are kept). Read while the tab is open, after the release, and again when the
 * work order changes (its version). Each part fails on its own. Only this work order's id and number are ever sent (PW-03).
 */

export interface CutPartsModel {
  readonly can: CuttingCan
  /** null: not read (no production.scrap.view). */
  readonly recuts: Part<readonly Replacement[]> | null
  /** null: not read (no production.cutting.view). */
  readonly orders: Part<readonly CutOrderOfWorkOrder[]> | null
  /** The recut whose Mark cut… is open. */
  readonly recut: string | null
  readonly busy: boolean
  /** A refused Mark cut, said inside its dialog (in the `cutting` catalogue's words). */
  readonly problem: Phrase | null
}

export interface CutPartsActions {
  onRecut?: (replacementId: string | null) => void
  onRecutDone?: (replacementId: string, cutLogId: string) => void
  onRetry?: (part: 'recuts' | 'orders') => void
}

const LOADING = { value: null, problem: null } as const

export function useCutParts(api: ApiClient, workOrder: Pick<WorkOrder, 'id' | 'number' | 'status' | 'version'> | null, permissions: readonly string[], open: boolean, onDone: (words: Phrase) => void): { model: CutPartsModel; actions: CutPartsActions } {
  const can = useMemo(() => cuttingCanOf(permissions), [permissions])
  const [recuts, setRecuts] = useState<Part<readonly Replacement[]>>(LOADING)
  const [orders, setOrders] = useState<Part<readonly CutOrderOfWorkOrder[]>>(LOADING)
  const [recut, setRecut] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const key = useRef<string | null>(null)
  const turn = useRef({ recuts: 0, orders: 0 })
  const id = workOrder?.id ?? null
  const number = workOrder?.number ?? null
  const released = !!workOrder && workOrder.status !== 'DRAFT'
  const asks = open && released

  const readRecuts = useCallback(() => {
    if (!id || !can.scrap) return
    const mine = ++turn.current.recuts
    getRecuts(api, id)
      .then((value) => mine === turn.current.recuts && setRecuts({ value, problem: null }))
      .catch((error: unknown) => mine === turn.current.recuts && setRecuts({ value: null, problem: readProblem(error) }))
  }, [api, id, can.scrap])

  const readOrders = useCallback(() => {
    if (!id || !number || !can.view) return
    const mine = ++turn.current.orders
    listCutOrders(api, cutOrdersQuery(number))
      .then((page) => mine === turn.current.orders && setOrders({ value: cutOrdersOf(page.rows, id), problem: null }))
      .catch((error: unknown) => mine === turn.current.orders && setOrders({ value: null, problem: readProblem(error) }))
  }, [api, id, number, can.view])

  useEffect(() => {
    if (!asks) return
    readRecuts()
    readOrders()
  }, [asks, readRecuts, readOrders, workOrder?.version])

  const done = useCallback(
    async (replacementId: string, cutLogId: string) => {
      const found = recuts.value?.find((row) => row.id === replacementId)
      if (!found || busy) return
      const idem = key.current ?? newIdempotencyKey()
      key.current = idem
      setBusy(true)
      setProblem(null)
      try {
        await recutDone(api, replacementId, { version: found.version, cutLogId }, idem)
        key.current = null
        setRecut(null)
        readRecuts()
        onDone({ key: 'notice.recutDone' })
      } catch (error) {
        key.current = newIdempotencyKey()
        setProblem(writeProblem(error))
      } finally {
        setBusy(false)
      }
    },
    [api, recuts.value, busy, readRecuts, onDone],
  )

  return {
    model: { can, recuts: can.scrap ? recuts : null, orders: can.view ? orders : null, recut, busy, problem },
    actions: {
      onRecut: (replacementId) => {
        key.current = replacementId ? newIdempotencyKey() : null
        setProblem(null)
        setRecut(replacementId)
      },
      onRecutDone: (replacementId, cutLogId) => void done(replacementId, cutLogId),
      onRetry: (part) => (part === 'recuts' ? readRecuts() : readOrders()),
    },
  }
}
