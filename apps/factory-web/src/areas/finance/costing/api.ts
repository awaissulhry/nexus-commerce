import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Finance › Costing › Standard vs actual (SCR-154, design finance.costing; B-W2a-21's API) and of the work
 * order's Labour & cost tab, with the answer's shape checked (zod; unknown fields are dropped). The shapes mirror
 * factory-domain costing/ledger/contracts.ts and costing/standards/contracts.ts; the enum lists mirror factory-domain
 * (costing.vitest.test.ts holds them equal). Every amount is the cost grain in minor units: the API drops it for a person
 * without money.cost, so each money field is optional (absent, never zero) and the screen draws no money column then.
 * Minutes, quantities, kinds and words are not money and come to every person with costing.view. The API's English words
 * are never drawn: the screen says its own from the codes. No person is named anywhere (labour is per work order and
 * operation: Statuto dei Lavoratori art. 4).
 */

export const COST_ENTRY_KINDS = ['MATERIAL', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'COMPLETION', 'ADJUSTMENT'] as const
export type CostEntryKind = (typeof COST_ENTRY_KINDS)[number]
/** The company's costing method (the accountant's; UNDECIDED until chosen). */
export const COSTING_METHODS = ['UNDECIDED', 'STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const
export type CostingMethod = (typeof COSTING_METHODS)[number]
/** What a ledger entry records (issue, return, scrap, labour, completion …). */
export const ENTRY_EVENTS = ['ISSUE', 'RETURN', 'STOCK_SCRAP', 'LABOUR', 'SCAN_SCRAP', 'REWORK_SCRAP', 'COMPLETION', 'OVERHEAD', 'SUBCONTRACT', 'ADJUSTMENT', 'REVERSAL'] as const
export type EntryEvent = (typeof ENTRY_EVENTS)[number]
/** Why a source event has no entry yet. */
// B-W2b-53: SCRAP_APPROVAL (scrap above a site's limit waits for the team leader).
export const WAITING_CODES = ['NOT_VALUED', 'NO_RATE', 'CURRENCY', 'LOCKED', 'NO_SCAN', 'SCRAP_APPROVAL'] as const
export type WaitingCode = (typeof WAITING_CODES)[number]
export const DOCUMENT_TYPES = ['StockMove', 'OperationScan', 'ReworkOrder', 'SubcontractOrder', 'SupplierInvoiceLine', 'WorkOrderCostEntry'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]
/** The steps from the basis to the actual (they add up to the variance exactly). */
export const BRIDGE_REASONS = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'] as const
export type BridgeReason = (typeof BRIDGE_REASONS)[number]
export const COST_PARTS = ['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD'] as const
export type CostPart = (typeof COST_PARTS)[number]
export const VARIANCE_BASES = ['STANDARD', 'ESTIMATE'] as const
export type VarianceBasis = (typeof VARIANCE_BASES)[number]
export const STANDARD_COST_STATUSES = ['DRAFT', 'FROZEN'] as const
export const STANDARD_COST_SOURCES = ['ROLLUP', 'PURCHASE', 'MANUAL'] as const
export type StandardCostSource = (typeof STANDARD_COST_SOURCES)[number]
/** The statuses the list may ask for (a draft or cancelled work order has no cost to compare). */
export const COSTED_STATUSES = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const
export type CostedStatus = (typeof COSTED_STATUSES)[number]

/** A cost-grain figure: absent for a person without money.cost. */
const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const itemRef = z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() })

export const workOrderCostRowSchema = z.object({
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    status: z.string(),
    companyId: z.string(),
    siteId: z.string(),
    style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
    pieces: z.number(),
    releasedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  currency: z.string(),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  basis: z.enum(VARIANCE_BASES).nullable(),
  standardTotal: cost(z.number().nullable()),
  estimateTotal: cost(z.number().nullable()),
  estimateComplete: z.boolean(),
  actualTotal: cost(z.number()),
  movedToStock: cost(z.number()),
  variance: cost(z.number().nullable()),
  variancePct: cost(z.string().nullable()),
  biggestReason: z.enum(BRIDGE_REASONS).nullable(),
  over: z.boolean(),
  final: z.boolean(),
  entries: z.number(),
})
export type WorkOrderCostRow = z.infer<typeof workOrderCostRowSchema>

export const costTilesSchema = z.object({
  overStandard: z.number().nullable(),
  varianceThisMonth: cost(z.number().nullable()),
  stockValue: cost(z.number().nullable()),
  unvaluedMoves: z.number(),
  wipValue: cost(z.number().nullable()),
  currency: z.string().nullable(),
  month: z.string(),
  words: z.string().nullable(),
})
export type CostTiles = z.infer<typeof costTilesSchema>

export const workOrderCostsSchema = z.object({ rows: z.array(workOrderCostRowSchema), nextCursor: z.string().nullable(), tiles: costTilesSchema })
export type WorkOrderCosts = z.infer<typeof workOrderCostsSchema>

const partsSchema = z.object({ material: cost(z.number()), labour: cost(z.number()), subcontract: cost(z.number()), overhead: cost(z.number()), total: cost(z.number()) })
const waitingSchema = z.object({ code: z.enum(WAITING_CODES), sourceType: z.enum(DOCUMENT_TYPES), sourceId: z.string(), words: z.string() })
export type WaitingItem = z.infer<typeof waitingSchema>

export const workOrderCostSchema = workOrderCostRowSchema.extend({
  standard: partsSchema.nullable(),
  standardMissing: z.array(z.object({ cellId: z.string(), colourwayCode: z.string(), size: z.string(), itemId: z.string().nullable(), words: z.string() })),
  estimate: partsSchema.extend({ complete: z.boolean(), missing: z.array(z.string()) }).nullable(),
  actual: z.object({
    material: cost(z.number()),
    labour: cost(z.number()),
    subcontract: cost(z.number()),
    overhead: cost(z.number()),
    adjustment: cost(z.number()),
    total: cost(z.number()),
    movedToStock: cost(z.number()),
    onWorkOrder: cost(z.number()),
    scrapLost: cost(z.number()),
    scrapFromStock: cost(z.number()),
  }),
  bridge: z.array(z.object({ reason: z.enum(BRIDGE_REASONS), amount: cost(z.number()) })).nullable(),
  parts: z.array(z.object({ part: z.enum(COST_PARTS), planned: cost(z.number().nullable()), actual: cost(z.number()), variance: cost(z.number().nullable()), perGarment: cost(z.number().nullable()) })),
  perGarment: z.object({ planned: cost(z.number().nullable()), actual: cost(z.number().nullable()) }),
  materials: z.array(
    z.object({
      item: itemRef,
      plannedQuantity: z.string().nullable(),
      issuedQuantity: z.string(),
      unitCost: cost(z.string().nullable()),
      standardUnitCost: cost(z.string().nullable()),
      amount: cost(z.number()),
      lots: z.array(z.object({ lotId: z.string().nullable(), lotCode: z.string().nullable(), hideId: z.string().nullable(), hideCode: z.string().nullable(), quantity: z.string(), amount: cost(z.number()) })),
    }),
  ),
  labour: z.array(
    z.object({
      operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), workCentreKind: z.string() }),
      plannedMinutes: z.string(),
      earnedMinutes: z.string(),
      perMinute: cost(z.string().nullable()),
      amount: cost(z.number()),
    }),
  ),
  scrap: z.array(z.object({ entryId: z.string(), event: z.enum(ENTRY_EVENTS), occurredAt: z.string(), item: itemRef.nullable(), quantity: z.string().nullable(), value: cost(z.number().nullable()) })),
  waitingItems: z.array(waitingSchema),
  words: z.string(),
})
export type WorkOrderCost = z.infer<typeof workOrderCostSchema>

export const ledgerEntrySchema = z.object({
  id: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  kind: z.enum(COST_ENTRY_KINDS),
  event: z.enum(ENTRY_EVENTS),
  occurredAt: z.string(),
  day: z.string(),
  item: itemRef.nullable(),
  quantity: z.string().nullable(),
  minutes: z.string().nullable(),
  unitCost: cost(z.string().nullable()),
  standardUnitCost: cost(z.string().nullable()),
  amount: cost(z.number()),
  currency: z.string(),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  standardId: z.string().nullable(),
  document: z.object({ type: z.enum(DOCUMENT_TYPES), id: z.string(), label: z.string() }).nullable(),
  reversalOfId: z.string().nullable(),
  reversedBy: z.object({ id: z.string(), occurredAt: z.string(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
})
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>

export const ledgerSchema = z.object({ entries: z.array(ledgerEntrySchema), nextCursor: z.string().nullable() })
export type Ledger = z.infer<typeof ledgerSchema>

export const reverseAnswerSchema = z.object({ entry: ledgerEntrySchema, reversals: z.array(ledgerEntrySchema) })
export type ReverseAnswer = z.infer<typeof reverseAnswerSchema>

export const standardCostSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.string() }),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.enum(STANDARD_COST_STATUSES),
  source: z.enum(STANDARD_COST_SOURCES),
  currency: z.string(),
  materialCost: cost(z.string()),
  labourCost: cost(z.string()),
  subcontractCost: cost(z.string()),
  overheadCost: cost(z.string()),
  unitCost: cost(z.string()),
  labourMinutes: z.string().nullable(),
  note: z.string().nullable(),
  inForce: z.boolean(),
  frozenAt: z.string().nullable(),
  version: z.number(),
})
export type StandardCost = z.infer<typeof standardCostSchema>

export const standardsSchema = z.object({ standards: z.array(standardCostSchema), nextCursor: z.string().nullable() })
export type Standards = z.infer<typeof standardsSchema>

export const methodSchema = z.object({
  companyId: z.string().nullable(),
  from: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  firstEntryAt: z.string().nullable(),
  entries: z.number(),
})
export type MethodView = z.infer<typeof methodSchema>

const clean = (query: Readonly<Record<string, string | number | null | undefined>>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

export interface WorkOrderCostsQuery {
  readonly companyId?: string | null
  readonly siteId?: string | null
  readonly status?: readonly CostedStatus[] | null
  readonly over?: boolean | null
  readonly q?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/work-orders: a page of work orders with standard, estimate at release, actual so far and variance, and the tiles. */
export function getWorkOrderCosts(api: ApiClient, query: WorkOrderCostsQuery, signal?: AbortSignal): Promise<WorkOrderCosts> {
  return api.get('/costing/work-orders', {
    query: clean({ companyId: query.companyId, siteId: query.siteId, status: query.status?.length ? query.status.join(',') : null, over: query.over ? 'true' : null, q: query.q, cursor: query.cursor, limit: query.limit ?? 50 }),
    schema: workOrderCostsSchema,
    signal,
  })
}

/** GET /costing/work-orders/:id: one work order's cost — the bridge, the parts, materials per lot, labour per operation, scrap. */
export async function getWorkOrderCost(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderCost> {
  const answer = await api.get(`/costing/work-orders/${encodeURIComponent(workOrderId)}`, { schema: z.object({ detail: workOrderCostSchema }), signal })
  return answer.detail
}

export interface LedgerQuery {
  readonly companyId?: string | null
  readonly siteId?: string | null
  readonly workOrderId?: string | null
  readonly kinds?: readonly CostEntryKind[] | null
  readonly from?: string | null
  readonly to?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/ledger: the cost ledger, newest first (every valuation event; a mistake is reversed, never edited). */
export function getLedger(api: ApiClient, query: LedgerQuery, signal?: AbortSignal): Promise<Ledger> {
  return api.get('/costing/ledger', {
    query: clean({ companyId: query.companyId, siteId: query.siteId, workOrderId: query.workOrderId, kind: query.kinds?.length ? query.kinds.join(',') : null, from: query.from, to: query.to, cursor: query.cursor, limit: query.limit ?? 50 }),
    schema: ledgerSchema,
    signal,
  })
}

/** POST /costing/entries/:id/reverse {reason}: a reversal dated now (its overhead with it); one key per attempt. */
export function reverseEntry(api: ApiClient, entryId: string, reason: string, idempotencyKey: string = newIdempotencyKey()): Promise<ReverseAnswer> {
  return api.post(`/costing/entries/${encodeURIComponent(entryId)}/reverse`, { body: { reason }, schema: reverseAnswerSchema, idempotencyKey })
}

export interface StandardsQuery {
  readonly companyId?: string | null
  /** FROZEN and in force on this day. */
  readonly on?: string | null
  readonly kind?: 'FINISHED' | 'MATERIAL' | null
  readonly q?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/standards?on=: the frozen standard per item in force on the day. */
export function getStandards(api: ApiClient, query: StandardsQuery, signal?: AbortSignal): Promise<Standards> {
  return api.get('/costing/standards', {
    query: clean({ companyId: query.companyId, on: query.on, status: query.on ? null : 'FROZEN', kind: query.kind, q: query.q, cursor: query.cursor, limit: query.limit ?? 50 }),
    schema: standardsSchema,
    signal,
  })
}

/** GET /costing/method: the company's costing method (the accountant's choice; UNDECIDED until made). */
export async function getMethod(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<MethodView> {
  const answer = await api.get('/costing/method', { query: clean({ companyId }), schema: z.object({ method: methodSchema }), signal })
  return answer.method
}
