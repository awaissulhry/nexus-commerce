import type { OrderMargin } from '../../../../finance/margins/api'
import type { MarginsCan } from '../../../../finance/margins/model'

/**
 * B-W2a-72 → F-SA-230 → F-OM-302: the order's margin as Money's Margin section reads it (money/view/MarginSection.tsx, its pure model
 * money/margin.ts): the margin as quoted, as estimated now and so far, where it went and by line, the cost lines set by hand and the
 * target, from `GET /costing/margins/orders/:id`. Margin grain only (Owner answer S2): the API drops what a person does not hold.
 */
export interface MarginTabModel {
  readonly can: MarginsCan
  /** The margin read (null: not asked — no costing.view or no margin grain, or the tab is not open). */
  readonly part: { readonly value: OrderMargin | null; readonly problem: string | null } | null
}
