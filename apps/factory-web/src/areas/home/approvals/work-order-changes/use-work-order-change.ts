'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OPEN_CUT_ORDER_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { getWorkOrder, type WorkOrder } from '../../../production/_shared/api'
import { useLive } from '../../../production/_shared/hooks'
import { getCutOrder, listCutOrders } from '../../../production/cutting/orders/api'
import { cutOrdersOf, cutOrdersQuery } from '../../../production/work-orders/cutting/model'
import { readProblem } from '../../../sales/quotes/problems'
import type { Loaded } from '../../../sales/quotes/record/record-model'
import { applyWorkOrderChange, declineWorkOrderChange, getWorkOrderChange, listWorkOrderChanges, type WorkOrderChange } from './api'
import { changeProblemOf, decidedNotice, type ChangeNotice, type ChangeProblem, type ChangeReviewActions, type ChangeReviewModel, type DecideDialog, type LayRecord } from './model'

/**
 * F-SA-245 — the container of the ONE decide window of a work-order change (./view/WorkOrderChangeReview.tsx draws it). Two hosts:
 * Home › Approvals (`?open=<change id>` of its row "Work order change · WO-…") and the work order's own page (its band notice). It
 * reads the change (`GET /production/work-order-changes/:id`; another customer's, or one this reader does not reach: the neutral
 * "not there any more"), the work order as it is now (workorders.view: its cells, what is cut and bundled — its own cells only)
 * and the lay it touches (production.cutting.view: the work order's cut orders, each record's lines on those cells; only this
 * work order's number and id are sent, PW-03). Each read fails alone. Apply and Leave as is carry the change's version and an
 * Idempotency-Key (a retry of the same write sends the same key); a refusal says its words and reads again.
 */

export interface ChangeReviewHost {
  readonly api: ApiClient
  /** The change the address opens (null: none). */
  readonly openId: string | null
  readonly offline: boolean
  readonly permissions: readonly string[]
  /** After Apply or Leave as is: the notice, and the change decided. */
  readonly onDecided: (decided: { readonly id: string; readonly notice: ChangeNotice; readonly change: WorkOrderChange }) => void
  /** A refusal that reads again: the host reads its list again too. */
  readonly onReload?: () => void
}

const loadedOf = <T,>(error: unknown): Loaded<T> => {
  if (isApiError(error) && error.kind === 'not_found') return { status: 'not_found' }
  if (isApiError(error) && error.kind === 'forbidden') return { status: 'forbidden' }
  return { status: 'error', problem: readProblem(error) }
}

/** The work order's cut orders that may hold the change's cells, each record read (open ones only: the lay it touches). */
async function laysOfWorkOrder(api: ApiClient, workOrder: Pick<WorkOrder, 'id' | 'number'>): Promise<LayRecord[]> {
  const page = await listCutOrders(api, cutOrdersQuery(workOrder.number))
  const open = cutOrdersOf(page.rows, workOrder.id).filter((entry) => (OPEN_CUT_ORDER_STATUSES as readonly string[]).includes(entry.order.status))
  const records = await Promise.all(open.map((entry) => getCutOrder(api, entry.order.id)))
  return records.map((record) => ({ cutOrder: { id: record.cutOrder.id, number: record.cutOrder.number, kind: record.cutOrder.kind, status: record.cutOrder.status }, lines: record.lines.filter((line) => line.workOrder.id === workOrder.id).map((line) => ({ id: line.id, seq: line.seq, workOrderSizeId: line.workOrderSizeId, quantity: line.quantity })) }))
}

export function useWorkOrderChangeReview(host: ChangeReviewHost): { readonly model: ChangeReviewModel | null; readonly actions: ChangeReviewActions; readonly busy: boolean; readonly refresh: () => void } {
  const { api, openId } = host
  const hostRef = useRef(host)
  hostRef.current = host
  const can = useMemo(() => {
    const held = new Set(host.permissions)
    return { workOrders: held.has('workorders.view'), lays: held.has('production.cutting.view') }
  }, [host.permissions])
  const [change, setChange] = useState<{ id: string; value: Loaded<WorkOrderChange> } | null>(null)
  const [workOrder, setWorkOrder] = useState<{ id: string; value: Loaded<WorkOrder> | null } | null>(null)
  const [lays, setLays] = useState<{ id: string; value: Loaded<readonly LayRecord[]> | null } | null>(null)
  const [dialog, setDialog] = useState<DecideDialog | null>(null)
  const [problem, setProblem] = useState<ChangeProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const keys = useRef<{ apply: string | null; decline: string | null }>({ apply: null, decline: null })
  const turn = useRef(0)

  const read = useCallback(async () => {
    if (!openId) return
    const mine = ++turn.current
    const still = () => mine === turn.current
    setChange((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    let found: WorkOrderChange
    try {
      found = await getWorkOrderChange(api, openId)
      if (!still()) return
      setChange({ id: openId, value: { status: 'ready', value: found } })
    } catch (error) {
      if (still()) setChange({ id: openId, value: loadedOf(error) })
      return
    }
    // The work order as it is now, and its lays (each fails alone; without the right, not read: the API decides).
    if (!found.workOrder || !can.workOrders) {
      setWorkOrder({ id: openId, value: null })
      setLays({ id: openId, value: null })
      return
    }
    const target = found.workOrder
    setWorkOrder((current) => (current?.id === openId && current.value?.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    let now: WorkOrder | null = null
    try {
      now = await getWorkOrder(api, target.id)
      if (still()) setWorkOrder({ id: openId, value: { status: 'ready', value: now } })
    } catch (error) {
      if (still()) setWorkOrder({ id: openId, value: loadedOf(error) })
    }
    if (!still()) return
    if (!can.lays || !now || now.status === 'DRAFT' || found.status !== 'PROPOSED') {
      setLays({ id: openId, value: null })
      return
    }
    setLays((current) => (current?.id === openId && current.value?.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    try {
      const records = await laysOfWorkOrder(api, now)
      if (still()) setLays({ id: openId, value: { status: 'ready', value: records } })
    } catch (error) {
      if (still()) setLays({ id: openId, value: loadedOf(error) })
    }
  }, [api, openId, can.workOrders, can.lays])

  useEffect(() => {
    setDialog(null)
    setProblem(null)
    keys.current = { apply: null, decline: null }
    void read()
  }, [read])

  const current = change && change.id === openId && change.value.status === 'ready' ? change.value.value : null
  const failed = (error: unknown, inDialog: boolean) => {
    const found = changeProblemOf(error)
    if (inDialog) setDialog((open) => (open ? { ...open, busy: false, problem: found.key } : open))
    else setProblem(found)
    if (found.reload) {
      void read()
      hostRef.current.onReload?.()
    }
  }

  const apply = async () => {
    if (!current || busy) return
    const key = keys.current.apply ?? newIdempotencyKey()
    keys.current.apply = key
    setBusy(true)
    setProblem(null)
    try {
      const done = await applyWorkOrderChange(api, current.id, { version: current.version }, key)
      keys.current.apply = null
      hostRef.current.onDecided({ id: current.id, change: done.change, notice: decidedNotice(done.change, 'applied', done.reprint.traveller ? done.reprint.words : null) })
    } catch (error) {
      // A refusal is an answer: the next try is a new write (a new key); a lost answer is retried with the same key.
      if (isApiError(error)) keys.current.apply = null
      failed(error, false)
    } finally {
      setBusy(false)
    }
  }

  const decline = async () => {
    if (!current || busy || dialog?.kind !== 'decline') return
    const words = dialog.words
    const key = keys.current.decline ?? newIdempotencyKey()
    keys.current.decline = key
    setBusy(true)
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const done = await declineWorkOrderChange(api, current.id, { version: current.version, words }, key)
      keys.current.decline = null
      setDialog(null)
      hostRef.current.onDecided({ id: current.id, change: done, notice: decidedNotice(done, 'declined') })
    } catch (error) {
      if (isApiError(error)) keys.current.decline = null
      failed(error, true)
    } finally {
      setBusy(false)
    }
  }

  const actions: ChangeReviewActions = {
    onApply: () => void apply(),
    onDecline: () => setDialog({ kind: 'decline', words: '', busy: false, problem: null }),
    onDeclineWords: (words) => setDialog((open) => (open ? { ...open, words, problem: null } : open)),
    onDeclineSend: () => void decline(),
    onCloseDialog: () => setDialog(null),
    onRetry: () => {
      setProblem(null)
      void read()
    },
  }

  const model: ChangeReviewModel | null = !openId
    ? null
    : {
        id: openId,
        change: change?.id === openId ? change.value : { status: 'loading' },
        workOrder: workOrder?.id === openId ? workOrder.value : current?.workOrder && can.workOrders ? { status: 'loading' } : null,
        lays: lays?.id === openId ? lays.value : null,
        customer: customerOf(workOrder?.id === openId && workOrder.value?.status === 'ready' ? workOrder.value.value : null, current),
        dialog,
        problem,
      }
  return { model, actions, busy, refresh: () => void read() }
}

/** The order's customer as the work order names it to this office reader (the order the change carries out). */
function customerOf(workOrder: Pick<WorkOrder, 'orders' | 'customer'> | null, change: Pick<WorkOrderChange, 'salesOrder'> | null): string | null {
  if (!workOrder || !change) return null
  return workOrder.orders.find((order) => order.id === change.salesOrder.id)?.partyName ?? workOrder.customer?.name ?? null
}

/**
 * The work order's waiting changes (its band notice): `GET /production/work-order-changes?workOrderId=&status=PROPOSED`, read again
 * when the work order's version moves and on the changes' own live events (`work_order_change.*` naming it). Null while not read or
 * without the right (workorders.view); a failed read draws no notice (the work order itself still draws).
 */
export function useWorkOrderChanges(api: ApiClient, workOrder: Pick<WorkOrder, 'id' | 'version'> | null, permissions: readonly string[]): { readonly changes: readonly WorkOrderChange[] | null; readonly reread: () => void } {
  const reads = permissions.includes('workorders.view')
  const [changes, setChanges] = useState<readonly WorkOrderChange[] | null>(null)
  const turn = useRef(0)
  const id = workOrder?.id ?? null
  const reread = useCallback(() => {
    if (!id || !reads) return
    const mine = ++turn.current
    listWorkOrderChanges(api, { workOrderId: id, status: 'PROPOSED', limit: 50 })
      .then((list) => mine === turn.current && setChanges(list.items))
      .catch(() => mine === turn.current && setChanges(null))
  }, [api, id, reads])
  useEffect(() => {
    reread()
  }, [reread, workOrder?.version])
  // A change proposed, applied, declined or made stale on this work order (the events name it: B-SA-041's live fields).
  useLive(
    (change) => {
      if (change.type.startsWith('work_order_change.') && change.fields.workOrderId === id) reread()
    },
    reread,
    reads && id !== null,
  )
  return { changes: reads ? changes : null, reread }
}
