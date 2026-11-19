'use client'

import { useMemo } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useBrandHealth } from '../../../../lib/production/health/use-health' // F-SA-235: the one HealthCard (moved to lib)
import type { Order } from '../api'
import type { OrderAbilities, RecordTab } from '../model'
import type { OrderRecordActions, OrderRecordModel } from './record-model'

export type ProductionActsModel = Pick<OrderRecordModel, 'health'>
export type ProductionActsActions = Pick<OrderRecordActions, 'health'>

/**
 * F-OP-134 (N-5): the Production tab's acts — F-SA-235: the order's health (raise to At risk / clear: production.brand.manage), read
 * while Production shows (workorders.view). Mounted by the container (OrderRecord.tsx), which hands what it returns to the view as
 * plain props; a view never imports it. The production read itself is the container's (the band and every tab read it).
 */
export function useProductionActs(input: {
  readonly api: ApiClient
  /** The order as this render draws it. */
  readonly order: Order | null
  readonly tab: RecordTab
  readonly can: OrderAbilities
  readonly permissions: readonly string[]
  readonly setNotice: (notice: OrderRecordModel['notice']) => void
}): { model: ProductionActsModel; actions: ProductionActsActions } {
  const { api, order, tab, can, permissions, setNotice } = input
  // ---- F-SA-235: the order's health, read while Production shows (workorders.view) ----
  const healthOwner = useMemo(() => (order && tab === 'production' && can.viewWorkOrders ? { orders: [{ id: order.id, number: order.number }], version: order.version } : null), [order, tab, can.viewWorkOrders])
  const health = useBrandHealth(api, healthOwner, permissions, (words) => setNotice({ tone: 'success', words: { key: words.key === 'health.clearedNotice' ? 'notice.healthCleared' : 'notice.healthRaised' } }))
  // ---- end F-SA-235
  return { model: { health: healthOwner ? health.model : null }, actions: { health: health.actions } }
}
