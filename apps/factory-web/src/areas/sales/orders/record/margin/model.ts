import type { OrderMargin } from '../../../../finance/margins/api'
import type { MarginsCan } from '../../../../finance/margins/model'

/**
 * B-W2a-72 — the sales order's Margin tab (design sales.orders rec:"Sales order" order.margin, read-only; FIN-047): the
 * margin as quoted, as estimated now and so far (strip + MarginMeter), where it went (Waterfall: a step opens Finance ›
 * Standard vs actual) and by line, from `GET /costing/margins/orders/:id`. Margin grain only (Owner answer S2): sales
 * see the margin %, never a cost amount — the API drops what a person does not hold, and the tab draws nothing for it.
 */
export interface MarginTabModel {
  readonly can: MarginsCan
  /** The margin read (null: not asked — no costing.view or no margin grain, or the tab is not open). */
  readonly part: { readonly value: OrderMargin | null; readonly problem: string | null } | null
}
