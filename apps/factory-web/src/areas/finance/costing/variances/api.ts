import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — Finance › Costing › Variances by work order (design finance.costing: the bridge's
 * "biggest reason" across work orders; FIN-030) on B-W2b-411's GET /costing/variances (costing.view over each line's company
 * and site): the variance lines of the closes that stand, newest close first, a page at a time, filtered by the page's
 * period (the days of the closes), with the totals per currency and category over every page. Unit costs and amounts are
 * the cost grain (absent without it: the screen draws no value column then). VARIANCE_CATEGORIES mirrors factory-domain
 * costing/variances/split (variances.vitest.test.ts holds it equal). Per work order, category and material: never per person.
 */

export const VARIANCE_CATEGORIES = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP', 'REWORK', 'SUBCONTRACT_PRICE', 'LOT_SIZE', 'OVERHEAD'] as const
export type VarianceCategory = (typeof VARIANCE_CATEGORIES)[number]

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const varianceRowSchema = z.object({
  id: z.string(),
  closeId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  companyId: z.string(),
  siteId: z.string(),
  category: z.enum(VARIANCE_CATEGORIES),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }).nullable(),
  standardQuantity: z.string().nullable(),
  actualQuantity: z.string().nullable(),
  standardUnitCost: cost(z.string().nullable()),
  actualUnitCost: cost(z.string().nullable()),
  amount: cost(z.number()),
  currency: z.string(),
  closedAt: z.string(),
  live: z.boolean(),
  note: z.string().nullable(),
})
export type VarianceRow = z.infer<typeof varianceRowSchema>

const variancesSchema = z.object({
  rows: z.array(varianceRowSchema),
  totals: z.array(z.object({ currency: z.string(), category: z.enum(VARIANCE_CATEGORIES), lines: z.number(), amount: cost(z.number()) })),
  nextCursor: z.string().nullable(),
  /** The API's words while the company's figures wait for the accountant (the screen says its own); null while on. */
  waits: z.string().nullable(),
})
export type Variances = z.infer<typeof variancesSchema>

export interface VariancesQuery {
  readonly companyId: string | null
  /** Europe/Rome days of the closes, both included (the page's period). */
  readonly from: string
  readonly to: string
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/variances: the period's variance lines of the closes that stand, newest close first. */
export function getVariances(api: ApiClient, query: VariancesQuery, signal?: AbortSignal): Promise<Variances> {
  const params: Record<string, string | number> = { from: query.from, to: query.to, live: 'true', limit: query.limit ?? 50 }
  if (query.companyId) params.companyId = query.companyId
  if (query.cursor) params.cursor = query.cursor
  return api.get('/costing/variances', { query: params, schema: variancesSchema, signal })
}
