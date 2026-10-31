import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { COSTING_METHODS } from '../costing/api'

/**
 * Every call of Finance › Costing › Margins (SCR-155, design finance.margins; B-W2a-29's API) and of the sales order's
 * Margin tab and Margin % column, with the answer's shape checked (zod; unknown fields are dropped). The shapes mirror
 * factory-domain costing/margins/contracts.ts; the enum lists mirror factory-domain (margins.vitest.test.ts holds them
 * equal). Each figure carries its own grain and the API drops what a person does not hold: the value is the price grain,
 * costs the cost grain, margin % the margin grain, and a margin AMOUNT (and every step of where it went) the margin grain
 * AND the cost grain (Owner answer S2: sales see margin %, never cost amounts). So every money field is optional (absent,
 * never zero) and the screen draws no column for it then. No person is named.
 */

export const SALES_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED'] as const
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number]
/** Quoted → now: the value's change and each cost part's (they add up to the margin change). */
export const WATERFALL_REASONS = ['PRICE', 'MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'] as const
export type WaterfallReason = (typeof WATERFALL_REASONS)[number]
/** What a work order's estimate rests on. */
export const SHARE_PLANS = ['STANDARD', 'ESTIMATE', 'QUOTED', 'ACTUAL'] as const

/** A figure of a grain: absent for a person without it. */
const grain = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

export const orderMarginRowSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.enum(SALES_ORDER_STATUSES), orderDate: z.string(), companyId: z.string(), party: z.object({ id: z.string(), name: z.string() }), customerRef: z.string().nullable() }),
  currency: z.string(),
  quotedValue: grain(z.number()),
  value: grain(z.number()),
  quotedCost: grain(z.number().nullable()),
  quotedMargin: grain(z.number().nullable()),
  quotedMarginPct: grain(z.string().nullable()),
  estimateCost: grain(z.number().nullable()),
  estimateMargin: grain(z.number().nullable()),
  estimateMarginPct: grain(z.string().nullable()),
  actualCost: grain(z.number()),
  actualMargin: grain(z.number().nullable()),
  actualMarginPct: grain(z.string().nullable()),
  marginChange: grain(z.number().nullable()),
  final: z.boolean(),
  started: z.boolean(),
  workOrders: z.number(),
  belowFloor: z.boolean().nullable(),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
})
export type OrderMarginRow = z.infer<typeof orderMarginRowSchema>

export const marginTilesSchema = z.object({
  averageMarginPct: grain(z.string().nullable()),
  belowFloor: z.number().nullable(),
  marginLostSinceQuote: grain(z.number().nullable()),
  orders: z.number(),
  unknown: z.number(),
  currency: z.string().nullable(),
  words: z.string().nullable(),
})
export type MarginTiles = z.infer<typeof marginTilesSchema>

const groupFigures = { orders: z.number(), value: grain(z.number()), estimateCost: grain(z.number().nullable()), marginPct: grain(z.string().nullable()) }

export const marginsSchema = z.object({
  rows: z.array(orderMarginRowSchema),
  nextCursor: z.string().nullable(),
  tiles: marginTilesSchema,
  byCustomer: z.array(z.object({ party: z.object({ id: z.string(), name: z.string() }), ...groupFigures })),
  byStyle: z.array(z.object({ style: z.object({ id: z.string(), code: z.string(), name: z.string() }), ...groupFigures })),
})
export type Margins = z.infer<typeof marginsSchema>
export type CustomerGroup = Margins['byCustomer'][number]
export type StyleGroup = Margins['byStyle'][number]

const partsSchema = z.object({ material: grain(z.number()), labour: grain(z.number()), subcontract: grain(z.number()), overhead: grain(z.number()), adjustment: grain(z.number()) })
const stageSchema = z.object({ value: grain(z.number()), cost: grain(z.number().nullable()), parts: partsSchema.nullable().optional(), margin: grain(z.number().nullable()), marginPct: grain(z.string().nullable()) })
export type MarginStage = z.infer<typeof stageSchema>

export const orderMarginSchema = orderMarginRowSchema.extend({
  quoted: stageSchema,
  estimate: stageSchema,
  actual: stageSchema,
  waterfall: z.array(z.object({ reason: z.enum(WATERFALL_REASONS), amount: grain(z.number()) })).nullable().optional(),
  leather: z.object({ quoted: grain(z.number().nullable()), actual: grain(z.number()) }),
  freight: z.object({ cost: grain(z.number().nullable()), words: z.string() }),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      colourway: z.object({ id: z.string(), code: z.string() }),
      quantity: z.number(),
      closedShort: z.number(),
      inWorkOrders: z.number(),
      quotedValue: grain(z.number()),
      value: grain(z.number()),
      quotedCost: grain(z.number().nullable()),
      estimateCost: grain(z.number().nullable()),
      actualCost: grain(z.number()),
      quotedMarginPct: grain(z.string().nullable()),
      estimateMarginPct: grain(z.string().nullable()),
      actualMarginPct: grain(z.string().nullable()),
    }),
  ),
  workOrderShares: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), kind: z.string(), status: z.string() }),
      pieces: z.number(),
      ofPieces: z.number(),
      done: z.boolean(),
      plan: z.enum(SHARE_PLANS),
      estimateCost: grain(z.number().nullable()),
      actualCost: grain(z.number()),
      method: z.enum(COSTING_METHODS),
      provisional: z.boolean(),
    }),
  ),
  words: z.string(),
})
export type OrderMargin = z.infer<typeof orderMarginSchema>
export type OrderMarginLine = OrderMargin['lines'][number]

export interface MarginsQuery {
  readonly companyId?: string | null
  readonly partyId?: string | null
  readonly styleId?: string | null
  readonly status?: readonly SalesOrderStatus[] | null
  readonly from?: string | null
  readonly to?: string | null
  readonly q?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

const clean = (query: Readonly<Record<string, string | number | null | undefined>>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

/** GET /costing/margins: a page of orders with their margin quoted, now and so far, the tiles and the groups over every order in scope. */
export function getMargins(api: ApiClient, query: MarginsQuery, signal?: AbortSignal): Promise<Margins> {
  return api.get('/costing/margins', {
    query: clean({ companyId: query.companyId, partyId: query.partyId, styleId: query.styleId, status: query.status?.length ? query.status.join(',') : null, from: query.from, to: query.to, q: query.q, cursor: query.cursor, limit: query.limit ?? 50 }),
    schema: marginsSchema,
    signal,
  })
}

/** GET /costing/margins/orders/:id: one order's profitability — the stages, where the margin went, by line, its work orders. */
export function getOrderMargin(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderMargin> {
  return api.get(`/costing/margins/orders/${encodeURIComponent(orderId)}`, { schema: orderMarginSchema, signal })
}
