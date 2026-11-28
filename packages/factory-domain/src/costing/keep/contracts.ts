import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { KEEP_REASON_MAX } from './rules'

/**
 * owb-pd3 (S4; brief owb-pd-server.md § Shape "pd3", which web B's Cost tab reads) — the contracts of the product's price against
 * its cost and of Keep. Prices are money.price, costs money.cost, what a price earns and the margin money.margin; the route asks
 * all three grains first (403 otherwise), so nothing is dropped from its answer.
 */

/** GET /costing/styles/:styleId/price-against-cost?revisionId= */
export const priceAgainstCostQuery = input({ revisionId: id() })
export type PriceAgainstCostQuery = z.output<typeof priceAgainstCostQuery>

const kept = output({
  /** The kept standard cost of one piece (the dearest frozen standard in force of the product's finished items). */
  amount: money.cost(z.string()),
  /** Its number: the kept cost sheet's version, else the how-many-th frozen standard of the item. */
  version: z.number().int(),
  keptAt: instant(),
})

export const priceAgainstCostView = output({
  currency: z.literal('EUR'),
  /** The margin target, a share of the price (SalesSettings.marginFloorPct of the company; 0 when none). */
  targetPct: notMoney(z.string()),
  /** The cost of one piece now, in the base size (the live components); null while a part is missing. */
  costNow: money.cost(z.string().nullable()),
  kept: kept.nullable(),
  rows: z.array(
    output({
      customer: output({ id: id(), code: z.string(), name: z.string() }),
      /** The colourway the price is for; null: every colourway. */
      material: z.string().nullable(),
      /** From how many pieces the price holds (1: the entry's own price; more: a quantity break). */
      minQty: z.number().int(),
      price: money.price(z.string()),
      /** The kept standard cost, else the cost now; null in another currency than EUR, or while a part is missing. */
      cost: money.cost(z.string().nullable()),
      earned: money.margin(z.string().nullable()),
      marginPct: money.margin(z.string().nullable()),
      flag: z.enum(['OK', 'UNDER_TARGET', 'UNDER_COST']).nullable(),
    }),
  ),
  /** The lowest price that keeps the target, from the same cost as the rows. */
  lowestPriceForTarget: money.cost(z.string().nullable()),
})
export type PriceAgainstCostView = z.infer<typeof priceAgainstCostView>

/** POST /costing/styles/:styleId/revisions/:revisionId/keep */
export const keepBody = input({
  /** Why the standard cost changes (stored with the version; the reason a person keeps it alone). */
  reason: z.string().trim().min(1).max(KEEP_REASON_MAX),
  /** The cost now as the person read it (`costNow`): a cost that moved since is refused (TOTAL_MOVED). */
  expectedTotal: money.cost(z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Expected the cost now as read, for example 185.60.')),
})
export type KeepBody = z.output<typeof keepBody>

export const keepView = output({
  /** KEPT: approved by the same person (the company lets one person keep a cost); SENT_FOR_APPROVAL: four eyes. */
  mode: z.enum(['KEPT', 'SENT_FOR_APPROVAL']),
  costSheetId: notMoney(id()),
  kept: kept.nullable(),
})
export type KeepView = z.infer<typeof keepView>
