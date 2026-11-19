'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useBrandHealth } from '../../../../lib/production/health/use-health' // F-SA-235: the one HealthCard (moved to lib)
import type { Order } from '../api'
import type { OrderAbilities, RecordTab } from '../model'
import type { OrderRecordActions, OrderRecordModel } from './record-model'
// ---- F-OP-112: Make work orders… in place — the Production page's own New work order hook (never a copy), the order fixed ----
import { abilitiesOf as productionAbilitiesOf } from '../../../production/_shared/model'
import { nextStyleOf, useNewWorkOrder } from '../../../production/work-orders/new/use-new-work-order'
import { orderOptionOf } from './production'

export type ProductionActsModel = Pick<OrderRecordModel, 'health' | 'makeWorkOrders'>
export type ProductionActsActions = Pick<OrderRecordActions, 'health' | 'makeWorkOrders'>

/**
 * F-OP-134 (N-5): the Production tab's acts — F-SA-235: the order's health (raise to At risk / clear: production.brand.manage), read
 * while Production shows (workorders.view); F-OP-112: Make work orders… in place (the Production page's useNewWorkOrder with this order
 * fixed: the style step; Create says "WO-0412 made (draft)" and offers "Make the next one: <style>" while styles remain; no navigation).
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
}): { model: ProductionActsModel; actions: ProductionActsActions } {
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
  return {
    model: { health: healthOwner ? health.model : null, makeWorkOrders: { dialog: make.model, next, can: productionCan } },
    actions: { health: health.actions, makeWorkOrders },
  }
}
