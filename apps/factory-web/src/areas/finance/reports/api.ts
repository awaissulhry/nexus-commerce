import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Finance › Reports › Stock valuation (SCR-239, design finance.reports; B-W2a-29's API), with the answer's
 * shape checked (zod; unknown fields are dropped). The shapes mirror factory-domain costing/valuation/contracts.ts; the
 * enum lists mirror factory-domain (reports.vitest.test.ts holds them equal). Every value is the cost grain: the API
 * drops it for a person without money.cost, so each value field is optional (absent, never zero) and the screen draws no
 * value column then. The API's English words are never drawn: the screen says its own from the codes.
 */

export const VALUATION_CATEGORIES = ['LEATHER', 'MATERIALS', 'TRIMS', 'PACKAGING', 'FINISHED_GOODS', 'WIP'] as const
export type ValuationCategory = (typeof VALUATION_CATEGORIES)[number]
export const VALUED_STATES = ['FULL', 'PART', 'NONE'] as const
export type ValuedState = (typeof VALUED_STATES)[number]
/** How the stock ledger valued a move (factory-domain inventory/ledger/valuation). */
export const VALUATION_METHODS = ['PURCHASE_PRICE', 'LOT_COST', 'STANDARD_COST', 'MANUAL'] as const
export type ValuationMethod = (typeof VALUATION_METHODS)[number]
/** The company's costing method (the accountant's; UNDECIDED until chosen). */
export const COSTING_METHODS = ['UNDECIDED', 'STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const
export type CostingMethod = (typeof COSTING_METHODS)[number]
// W2b (B-W2b-01): CUSTOMER_RETURN, SUPPLIER_RETURN, SHIPMENT (factory-domain STOCK_MOVE_REASONS).
export const MOVE_REASONS = ['OPENING', 'RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'COUNT', 'SCRAP', 'PRODUCTION_RECEIPT', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'SHIPMENT'] as const
export type MoveReason = (typeof MOVE_REASONS)[number]

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const itemRef = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.string(), tracking: z.string() })
const siteRef = z.object({ id: z.string(), code: z.string() })
const methodSchema = z.object({ companyId: z.string(), method: z.enum(COSTING_METHODS), provisional: z.boolean() })
export type CompanyMethod = z.infer<typeof methodSchema>

export const valuationRowSchema = z.object({
  category: z.enum(VALUATION_CATEGORIES),
  companyId: z.string(),
  site: siteRef,
  item: itemRef.nullable(),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), done: z.boolean() }).nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  hides: z.number(),
  areaM2: z.string().nullable(),
  value: cost(z.number()),
  unitCost: cost(z.string().nullable()),
  currency: z.string().nullable(),
  methods: z.array(z.enum(VALUATION_METHODS)),
  valued: z.enum(VALUED_STATES),
  unvaluedMoves: z.number(),
  dependsOnMethod: z.boolean(),
})
export type ValuationRow = z.infer<typeof valuationRowSchema>

export const valuationSchema = z.object({
  asOf: z.string().nullable(),
  asOfDay: z.string().nullable(),
  rows: z.array(valuationRowSchema),
  categories: z.array(z.object({ category: z.enum(VALUATION_CATEGORIES), rows: z.number(), value: cost(z.number().nullable()), currency: z.string().nullable() })),
  value: cost(z.number().nullable()),
  currency: z.string().nullable(),
  residue: cost(z.number().nullable()),
  unvaluedMoves: z.number(),
  methods: z.array(methodSchema),
  truncated: z.boolean(),
})
export type Valuation = z.infer<typeof valuationSchema>

export const layerSchema = z.object({
  moveId: z.string(),
  reason: z.enum(MOVE_REASONS),
  occurredAt: z.string(),
  day: z.string(),
  reference: z.string().nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  quantity: z.string(),
  method: z.enum(VALUATION_METHODS).nullable(),
  unitCost: cost(z.string().nullable()),
  value: cost(z.number().nullable()),
  receipt: z.object({ id: z.string(), number: z.string() }).nullable(),
  purchaseOrder: z.object({ id: z.string(), number: z.string(), unitPrice: cost(z.string()), uom: z.string(), currency: z.string() }).nullable(),
  balanceQuantity: z.string(),
  balanceValue: cost(z.number()),
  reversalOfId: z.string().nullable(),
})
export type Layer = z.infer<typeof layerSchema>

export const layersSchema = z.object({
  asOf: z.string().nullable(),
  site: siteRef,
  item: itemRef,
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  quantity: z.string(),
  value: cost(z.number()),
  unitCost: cost(z.string().nullable()),
  lotCost: cost(z.string().nullable()),
  currency: z.string().nullable(),
  opening: z.object({ quantity: z.string(), value: cost(z.number()) }),
  layers: z.array(layerSchema),
  complete: z.boolean(),
  method: methodSchema,
  dependsOnMethod: z.boolean(),
})
export type Layers = z.infer<typeof layersSchema>

/** The report's filters as the API reads them (the page's address holds the same, `site` for siteId). */
export interface ValuationQuery {
  readonly asOf?: string | null
  readonly companyId?: string | null
  readonly siteId?: string | null
  readonly category?: ValuationCategory | null
  readonly q?: string | null
}

const clean = (query: Readonly<Record<string, string | number | null | undefined>>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

/** GET /costing/valuation: every stock key and work order valued on the day (inventory.stock.view; values: cost grain). */
export function getValuation(api: ApiClient, query: ValuationQuery, signal?: AbortSignal): Promise<Valuation> {
  return api.get('/costing/valuation', { query: clean({ asOf: query.asOf, companyId: query.companyId, siteId: query.siteId, category: query.category, q: query.q }), schema: valuationSchema, signal })
}

/** The stock key of a row (WIP has none: its value is the work order's cost ledger). */
export interface LayerKey {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId?: string | null
  readonly lotId?: string | null
  readonly asOf?: string | null
}

/** The latest moves shown in "How this lot is valued" (the API gives the balance before them). */
export const LAYER_LIMIT = 50

/** GET /costing/valuation/layers: how one stock key is valued — the method, its moves with their costs, the receipts' prices. */
export function getLayers(api: ApiClient, key: LayerKey, signal?: AbortSignal): Promise<Layers> {
  return api.get('/costing/valuation/layers', {
    query: clean({ siteId: key.siteId, itemId: key.itemId, itemColourId: key.itemColourId, lotId: key.lotId, asOf: key.asOf, limit: LAYER_LIMIT }),
    schema: layersSchema,
    signal,
  })
}
