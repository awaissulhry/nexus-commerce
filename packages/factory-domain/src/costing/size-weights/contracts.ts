import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { sizeSplitView } from '../sheet-components/contracts'
import { COST_SHEET_STATES } from '../sheet-versions/rules'
import { WEIGHT_SOURCES } from './rules'

/**
 * The contracts of size weights and the cost by size (B-W2b-420; FIN-016; design products.styles › Cost "Cost by size"). A
 * weight is no money; a size's cost and its extra cost are `money.cost`, a suggested price surcharge and the style's own
 * surcharges `money.price`.
 */

const weight = () => z.string().regex(/^\d{1,5}(\.\d{1,4})?$/, 'Expected a weight above 0 with at most 4 decimals.')

export const sizeWeightsQuery = input({
  styleId: id(),
  /** The season whose mix is in force (its own, else every season's). */
  seasonId: id().optional(),
})
export type SizeWeightsQuery = z.output<typeof sizeWeightsQuery>

const weightSet = output({
  seasonId: id().nullable(),
  season: output({ code: z.string(), status: z.string() }).nullable(),
  weights: z.record(z.string(), z.string()),
  shares: z.array(output({ size: z.string(), weight: z.string(), sharePct: z.string() })),
})

export const sizeWeightsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), sizes: z.array(z.string()) }),
  sets: z.array(weightSet),
  /** The mix in force for the season asked (its own, else every season's); null without a season asked or without weights. */
  inForce: output({ seasonId: id().nullable(), source: z.enum(WEIGHT_SOURCES), weights: z.record(z.string(), z.string()) }).nullable(),
})

export const putSizeWeightsBody = input({
  styleId: id(),
  /** A season of the style's company; null: every season. */
  seasonId: id().nullable(),
  /** Size → relative weight; empty: the mix is cleared. */
  weights: z.record(z.string(), weight()),
})
export type PutSizeWeightsBody = z.output<typeof putSizeWeightsBody>

export const bySizeView = output({
  sheet: output({ id: id(), sheetVersion: z.number().int(), state: z.enum(COST_SHEET_STATES), currency: z.string(), baseSize: z.string(), styleId: id() }),
  sizes: z.array(z.string()),
  baseSize: z.string(),
  split: z.array(sizeSplitView),
  weights: output({
    source: z.enum(WEIGHT_SOURCES).nullable(),
    weights: z.record(z.string(), z.string()).nullable(),
    shares: z.array(output({ size: z.string(), weight: z.string(), sharePct: z.string() })),
    weighted: money.cost(z.string().nullable()),
    missing: z.array(z.string()),
  }),
  /** A size is suggested a surcharge when its cost is at least this percent above the base size's. */
  fromPct: z.string(),
  surcharges: z.array(
    output({
      size: z.string(),
      extraCost: money.cost(z.string()),
      extraPct: money.cost(z.string()),
      /** The price surcharge that keeps the version's target margin; null without one. */
      priceSurcharge: money.price(z.string().nullable()),
      /** The style's own surcharge for the size now (an amount in its currency, or a percent of the price). */
      current: output({ amount: money.price(z.string().nullable()), currency: z.string().nullable(), pct: money.price(z.string().nullable()) }).nullable(),
    }),
  ),
  words: z.string(),
})
