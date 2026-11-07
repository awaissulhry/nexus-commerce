import { portalOrderCounts } from '../../../../modules/purchasing/portal-orders/counts'
import type { HomeSource } from './index'

/**
 * B-W2b-174 (design portal.supplier.home "five counts", portal.supplier.orders chips): the supplier's purchase orders that
 * wait for its answer, and those late (a line still open whose confirmed date, else the date asked, has passed). Null when
 * the person does not see purchase orders (their role) or they cannot be counted.
 */
export const PURCHASE_ORDER_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'purchase-orders',
  counts: [
    { key: 'purchase_orders.to_confirm', area: 'orders', kinds: ['SUPPLIER'], words: { it: 'Ordini da confermare', en: 'Orders to confirm' } },
    { key: 'purchase_orders.late', area: 'orders', kinds: ['SUPPLIER'], words: { it: 'Ordini in ritardo', en: 'Late orders' } },
  ],
  async read(_app, request, now) {
    const counts = await portalOrderCounts(request, now)
    return { 'purchase_orders.to_confirm': counts?.toConfirm ?? null, 'purchase_orders.late': counts?.late ?? null }
  },
})
