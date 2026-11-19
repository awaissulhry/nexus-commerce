'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useBrandHealth } from '../../../../lib/production/health/use-health' // F-SA-235: the one HealthCard (moved to lib)
import type { Order } from '../api'
import type { OrderAbilities, RecordTab } from '../model'
import type { OrderRecordActions, OrderRecordModel } from './record-model'
// ---- F-OP-112: Make work orders… in place — the Production page's own New work order hook (never a copy), the order fixed ----
import { abilitiesOf as productionAbilitiesOf } from '../../../production/_shared/model'
import { nextStyleOf, useNewWorkOrder } from '../../../production/work-orders/new/use-new-work-order'
import { orderOptionOf } from './production'
// F-OP-113: the work-order rows' acts in place (the lib's one hook: in place Due · Priority · Rush, the row ⋯'s dialogs).
import { useWorkOrderActs } from '../../../../lib/production/work-order-acts/use-work-order-acts'
// ---- F-OP-116: decide in place — the order's work-order changes (one read) and the ONE decide window, hosted here (no address word) ----
import { listWorkOrderChanges, type WorkOrderChange } from '../../../home/approvals/work-order-changes/api'
import { useWorkOrderChangeReview } from '../../../home/approvals/work-order-changes/use-work-order-change'
import { readProblem, writeProblem } from '../model'
import { doneStillToDoTask } from '../api'

export type ProductionActsModel = Pick<OrderRecordModel, 'health' | 'makeWorkOrders' | 'workOrderActs' /* F-OP-113 */ | 'orderChanges' /* F-OP-116 */>
export type ProductionActsActions = Pick<OrderRecordActions, 'health' | 'makeWorkOrders' | 'workOrderActs' /* F-OP-113 */ | 'orderChanges' | 'onTaskDone' /* F-OP-116 */>

/** F-OP-116 (R-12): a refused Done in words — "Production does this" (403 refusal/PRODUCTION_DOES_THIS), else the write's own. */
export function taskDoneProblemOf(error: unknown): { key: string; params?: Record<string, string | number> } {
  const words = writeProblem(error)
  return words.key === 'problem.write.forbidden' ? { key: 'wo.heldHold' } : { key: words.key, ...(words.params ? { params: words.params } : {}) }
}

/**
 * F-OP-134 (N-5): the Production tab's acts — F-SA-235: the order's health (raise to At risk / clear: production.brand.manage), read
 * while Production shows (workorders.view); F-OP-112: Make work orders… in place (the Production page's useNewWorkOrder with this order
 * fixed: the style step; Create says "WO-0412 made (draft)" and offers "Make the next one: <style>" while styles remain; no navigation);
 * F-OP-113: the work-order rows' acts (useWorkOrderActs: due, priority and rush in place with the row's version, the row ⋯'s dialogs
 * on the work order read afresh; a write reads the order's work again, its rows staying where they are).
 * Mounted by the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The
 * production read itself is the container's (the band and every tab read it).
 */
export function useProductionActs(input: {
  readonly api: ApiClient
  /** The order as this render draws it. */
  readonly order: Order | null
  readonly tab: RecordTab
  readonly can: OrderAbilities
  readonly permissions: readonly string[]
  readonly setNotice: (notice: OrderRecordModel['notice']) => void
  /** F-OP-112: read the order and its production again (a work order was made). */
  readonly reload: () => void
  /** F-OP-113: read the order's work again in place (a work order changed here: its rows keep their places, no skeleton). */
  readonly rereadWork?: () => void
  /** F-OP-116: the live stream is offline (the decide window holds its writes). */
  readonly offline?: boolean
}): { model: ProductionActsModel; actions: ProductionActsActions; /* F-OP-116 */ rereadChanges: () => void } {
  const { api, order, tab, can, permissions, setNotice, reload } = input
  // ---- F-SA-235: the order's health, read while Production shows (workorders.view) ----
  const healthOwner = useMemo(() => (order && tab === 'production' && can.viewWorkOrders ? { orders: [{ id: order.id, number: order.number }], version: order.version } : null), [order, tab, can.viewWorkOrders])
  const health = useBrandHealth(api, healthOwner, permissions, (words) => setNotice({ tone: 'success', words: { key: words.key === 'health.clearedNotice' ? 'notice.healthCleared' : 'notice.healthRaised' } }))
  // ---- end F-SA-235
  // ---- F-OP-112: Make work orders… in place ----
  const productionCan = useMemo(() => productionAbilitiesOf(permissions), [permissions])
  const [next, setNext] = useState<{ styleId: string; code: string } | null>(null)
  const orderId = order?.id ?? null
  useEffect(() => setNext(null), [orderId]) // another order: nothing was made on it here
  const make = useNewWorkOrder(api, {
    canSearch: false,
    onMade: (made, asked) => {
      setNotice({ tone: 'success', words: { key: 'wo.made', params: { number: made.number } } })
      setNext(nextStyleOf(asked.lines, asked.styleId))
      reload()
    },
  })
  const makeWorkOrders = {
    onOpen: () => {
      if (order && productionCan.manage) make.open({ order: orderOptionOf(order), styleId: next?.styleId ?? null })
    },
    dialog: {
      onNew: (open: boolean) => {
        if (!open) make.close()
      },
      newOrder: make.actions,
    },
  }
  // ---- end F-OP-112
  // ---- F-OP-113: the work-order rows' acts; a write says its notice (if any) and reads the order's work again in place ----
  const rereadWork = input.rereadWork ?? reload
  const acts = useWorkOrderActs(api, permissions, (written) => {
    if (written.notice) setNotice({ tone: 'success', words: written.notice })
    rereadWork()
  })
  // ---- end F-OP-113
  // ---- F-OP-116 (10-order-page §5.2, §6): the order's work-order changes — every state, newest first (the Changes tab's section; a
  // row's "Change waits" reads the PROPOSED ones) — read with the order (orders.view; the API's wall: this order's customer only), and
  // again on a work_order_change.* event (the container calls rereadChanges). The ONE decide window (Approvals' own) opens here by
  // the page's state, never an address word; Apply / Leave as is reads the order's work and the changes again.
  const [changes, setChanges] = useState<{ readonly value: WorkOrderChange[] | null; readonly problem: string | null } | null>(null)
  const changesTurn = useRef(0)
  const rereadChanges = useCallback(() => {
    if (!orderId) return
    const mine = ++changesTurn.current
    setChanges((known) => known ?? { value: null, problem: null })
    listWorkOrderChanges(api, { salesOrderId: orderId, status: 'ALL', limit: 50 })
      .then((list) => mine === changesTurn.current && setChanges({ value: list.items, problem: null }))
      .catch((error: unknown) => mine === changesTurn.current && setChanges((known) => (known?.value ? known : { value: null, problem: readProblem(error) })))
  }, [api, orderId])
  useEffect(() => rereadChanges(), [rereadChanges])
  const [openChange, setOpenChange] = useState<string | null>(null)
  const review = useWorkOrderChangeReview({
    api,
    openId: openChange,
    offline: !!input.offline,
    permissions,
    onDecided: (decided) => {
      const number = decided.change.workOrder?.number ?? decided.change.madeWorkOrder?.number ?? decided.change.salesOrder.number
      setNotice({ tone: 'success', words: { key: decided.notice.key === 'notice.changeApplied' ? 'wo.changeApplied' : 'wo.changeDeclined', params: { number } } })
      setOpenChange(null)
      rereadWork()
      rereadChanges()
    },
    onReload: () => {
      rereadWork()
      rereadChanges()
    },
  })
  const orderChanges = { list: changes, review: openChange ? review.model : null, busy: review.busy }
  // Still to do › a production task's Done (its assignee or tasks.manage over its work order; anyone else: "Production does this").
  const [doing, setDoing] = useState(false)
  const onTaskDone = (taskId: string, version: number) => {
    if (!orderId || doing) return
    setDoing(true)
    doneStillToDoTask(api, orderId, taskId, version)
      .then(() => {
        setNotice({ tone: 'success', words: { key: 'wo.taskDone' } })
        rereadWork()
      })
      .catch((error: unknown) => setNotice({ tone: 'danger', words: taskDoneProblemOf(error) }))
      .finally(() => setDoing(false))
  }
  // ---- end F-OP-116
  return {
    model: { health: healthOwner ? health.model : null, makeWorkOrders: { dialog: make.model, next, can: productionCan }, workOrderActs: can.viewWorkOrders ? acts.model : null /* F-OP-113 */, orderChanges /* F-OP-116 */ },
    actions: { health: health.actions, makeWorkOrders, workOrderActs: acts.actions /* F-OP-113 */, orderChanges: { ...review.actions, onOpen: setOpenChange } /* F-OP-116 */, onTaskDone /* F-OP-116 */ },
    rereadChanges, // F-OP-116
  }
}
