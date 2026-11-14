import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { SHEET_CATEGORIES } from '../sheet-components/components'
import { COST_SHEET_STATES } from '../sheet-versions/rules'
import { GOAL_BASES, GOAL_STATES } from './rules'

/**
 * The contract of the goal-seek (B-W2b-420; FIN-013; design products.styles › Cost "Target price": Target, Allowed cost, Gap,
 * Biggest lines). The target price is `money.price`, margins `money.margin`, costs and the shares and cuts of the cost
 * `money.cost`. A target the caller may not see (no price or margin grain) is not used: the answer says so in `held`.
 */

const priceText = () => z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Expected a price above 0, with at most 12 digits and 6 decimals.')
const marginText = () => z.string().regex(/^-?\d{1,3}(\.\d{1,4})?$/, 'Expected a percent below 100 with at most 4 decimals.')

export const goalSeekQuery = input({
  /** Left out: the version's own target price. */
  targetPrice: money.price(priceText().optional()),
  /** Left out: the version's own target margin. */
  targetMarginPct: money.margin(marginText().optional()),
  /** The cost read: the weighted cost of the size mix (default when the version has weights), the base size's, or one size's. */
  basis: z.enum(GOAL_BASES).optional(),
  size: z.string().trim().min(1).max(40).optional(),
})
export type GoalSeekQuery = z.output<typeof goalSeekQuery>

export const goalSeekView = output({
  sheet: output({ id: id(), sheetVersion: z.number().int(), state: z.enum(COST_SHEET_STATES), currency: z.string(), baseSize: z.string() }),
  basis: output({ kind: z.enum(GOAL_BASES), size: z.string().nullable() }),
  target: output({ price: money.price(z.string().nullable()), marginPct: money.margin(z.string().nullable()), from: z.enum(['ASKED', 'SHEET', 'NONE']) }),
  cost: money.cost(z.string().nullable()),
  allowedCost: money.cost(z.string().nullable()),
  gap: money.cost(z.string().nullable()),
  marginAtCost: money.margin(z.string().nullable()),
  priceForMargin: money.price(z.string().nullable()),
  state: z.enum(GOAL_STATES),
  lines: z.array(
    output({
      lineId: id(),
      seq: z.number().int(),
      category: z.enum(SHEET_CATEGORIES),
      label: z.string().nullable(),
      cost: money.cost(z.string()),
      sharePct: money.cost(z.string()),
      cutAlonePct: money.cost(z.string().nullable()),
      cutShared: money.cost(z.string().nullable()),
    }),
  ),
  words: z.string(),
  /** Why a target was not used (a grain the caller does not hold); null when both could be. */
  held: z.string().nullable(),
})
