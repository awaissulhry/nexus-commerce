import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * owb-pd5b step 5.3 (S4; brief owb-pd-server.md § Shape "pd3") — the Cost tab's own calls, with this web's own zod (checked against pd3
 * as landed by owb-pd8b: every field the page draws is read, a new one never breaks it): price against cost (every CUSTOMER price list
 * entry of the product against its cost, the target, the kept standard cost and the cost now; the answer is the view itself, no wrapper
 * — the price, the cost AND the margin grain, else 403: the page does not ask then) and Keep
 * (ONE command: kept by the same person when the company allows it, else sent for approval to Finance — four eyes). EUR only.
 */

const enc = encodeURIComponent

const kept = z.object({ amount: z.string(), version: z.number().int(), keptAt: z.string() })

export const priceAgainstCost = z.object({
  currency: z.string(),
  /** The margin target, a share of the price (SalesSettings.marginFloorPct). */
  targetPct: z.string(),
  costNow: z.string().nullable(),
  kept: kept.nullable(),
  rows: z.array(
    z.object({
      customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      material: z.string().nullable(),
      minQty: z.number().int(),
      price: z.string(),
      cost: z.string().nullable(),
      earned: z.string().nullable(),
      marginPct: z.string().nullable(),
      flag: z.enum(['OK', 'UNDER_TARGET', 'UNDER_COST']).nullable(),
    }),
  ),
  lowestPriceForTarget: z.string().nullable(),
})
export type PriceAgainstCost = z.infer<typeof priceAgainstCost>
export type PriceAgainstCostRow = PriceAgainstCost['rows'][number]

/** `GET /costing/styles/:styleId/price-against-cost?revisionId=` (the price, the cost and the margin grain). */
export function readPriceAgainstCost(api: ApiClient, styleId: string, revisionId: string, signal?: AbortSignal): Promise<PriceAgainstCost> {
  return api.get(`/costing/styles/${enc(styleId)}/price-against-cost`, { query: { revisionId }, schema: priceAgainstCost, signal })
}

export const keepAnswer = z.object({ mode: z.enum(['KEPT', 'SENT_FOR_APPROVAL']), costSheetId: z.string(), kept: kept.nullable() })
export type KeepAnswer = z.infer<typeof keepAnswer>

/** `POST /costing/styles/:styleId/revisions/:revisionId/keep { reason, expectedTotal }` — the cost now as the standard cost. */
export function keepCost(api: ApiClient, styleId: string, revisionId: string, body: { reason: string; expectedTotal: string }): Promise<KeepAnswer> {
  return api.post(`/costing/styles/${enc(styleId)}/revisions/${enc(revisionId)}/keep`, { body, schema: keepAnswer, idempotencyKey: newIdempotencyKey() })
}
