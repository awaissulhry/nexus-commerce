import { z } from 'zod'
import { AGE_BUCKETS } from '@nexus/factory-domain/purchasing/subcontract-depth/ageing'
import { BALANCE_FLAGS, CONSUMPTION_KINDS } from '@nexus/factory-domain/purchasing/subcontract-depth/balance'
import { COST_KINDS } from '@nexus/factory-domain/purchasing/subcontract-depth/cost'
import { AGREEMENT_STATUSES } from '@nexus/factory-domain/purchasing/subcontract-depth/terms'
import { SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { downloadLink } from '../../../../record-panels/api'
import type { Presigned } from '../../../../record-panels/api'

/**
 * Subcontracting in depth on screen (B-W2b-344), the calls of B-W2b-331's API (apps/factory-api modules/purchasing/
 * subcontract-depth/contract.ts) with their answers checked (zod; unknown fields dropped): the written terms that cover an
 * order (SCM-049), the order's material balance and the workshop's declaration and adjustments (SCM-143, SCM-144), its cost
 * on the work order with the charges booked and taken back (SCM-146), the days out of our material at each workshop
 * (SCM-150) and the jobs whose balance is still open (the "Balance open" tile). Prices, amounts and the bridge are costs:
 * the API drops them for a role without the cost grain, so they are optional here and drawn only with `money.cost`. Every
 * write takes the order's version and an Idempotency-Key. The API's English (`words`, `actions`, the flags' words, the
 * waiting reasons) is read only to know WHETHER something holds: the screen says WHY in its own words (./model.ts).
 */

const enc = encodeURIComponent
const base = (orderId: string) => `/purchasing/subcontracting/orders/${enc(orderId)}`
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const held = z.string().nullable()
const cost = <T extends z.ZodType>(schema: T) => schema.optional()

export const FLAGS = BALANCE_FLAGS
export type BalanceFlag = (typeof BALANCE_FLAGS)[number]
export const KINDS = COST_KINDS
export type CostKind = (typeof COST_KINDS)[number]
export const BUCKETS = AGE_BUCKETS
export type AgeBucket = (typeof AGE_BUCKETS)[number]

// ---- the written terms (SCM-049) ------------------------------------------------------------------------------------------

const agreementSchema = z.object({
  id: z.string(),
  revision: z.number(),
  title: z.string(),
  status: z.enum(AGREEMENT_STATUSES),
  workshop: ref,
  validFrom: z.string(),
  validUntil: z.string().nullable(),
  signedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  file: z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), status: z.string() }).nullable(),
  inForceToday: z.boolean(),
  expiresInDays: z.number().nullable(),
})
export type Agreement = z.infer<typeof agreementSchema>

const termsSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), orderDate: z.string(), workshop: z.object({ id: z.string(), name: z.string() }) }),
  covering: agreementSchema.nullable(),
  /** Why none covers the order (the API's English: read for WHETHER, never drawn). */
  words: z.string().nullable(),
  /** The law's reference ("L. 192/1998 art. 2"), drawn as it is. */
  law: z.string(),
  revisions: z.array(agreementSchema),
})
export type OrderTerms = z.infer<typeof termsSchema>

export function orderTerms(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderTerms> {
  return api.get(`${base(orderId)}/terms`, { schema: termsSchema, ...(signal ? { signal } : {}) })
}

/** The signed terms' file: a presigned GET that lives 60 seconds (files.read; an attachment). */
export function termsDownload(api: ApiClient, fileId: string): Promise<Presigned> {
  return downloadLink(api, fileId).then((answer) => answer.download)
}

// ---- the material balance (SCM-143, SCM-144) -----------------------------------------------------------------------------

const quantities = { used: z.string(), returned: z.string(), scrapped: z.string() }
const rowSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(CONSUMPTION_KINDS),
  ...quantities,
  receipt: z.object({ id: z.string(), seq: z.number() }).nullable(),
  reportedAt: z.string(),
  reasonCode: z.string().nullable(),
  reason: z.string().nullable(),
  bookedAt: z.string(),
  /** Who booked it: a name inside this one record only (never a filter or a total). */
  bookedBy: z.string().nullable(),
})
export type ConsumptionRow = z.infer<typeof rowSchema>

const balanceLineSchema = z.object({
  kitLineId: z.string(),
  seq: z.number(),
  item: ref,
  colour: ref.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  uom: z.string(),
  sentAt: z.string().nullable(),
  sent: z.string(),
  ...quantities,
  open: z.string(),
  short: z.string().nullable(),
  /** The flags; their `words` are the API's English (never drawn: the screen words each flag from the line's facts). */
  flags: z.array(z.object({ flag: z.enum(BALANCE_FLAGS) })),
  checkedByWorkshop: z.object({ quantity: z.string(), at: z.string().nullable(), note: z.string().nullable() }).nullable(),
  announcedBack: z.string(),
  backInOurPlaces: z.string(),
  daysOut: z.number().nullable(),
  rows: z.array(rowSchema),
  suggestion: z.object(quantities),
  actions: z.object({ declare: held, adjust: held }),
})
export type BalanceLine = z.infer<typeof balanceLineSchema>

export const balanceSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.enum(SUBCONTRACT_ORDER_STATUSES), version: z.number(), allBack: z.boolean(), someBack: z.boolean() }),
  balanceOpen: z.boolean(),
  lines: z.array(balanceLineSchema),
  receipts: z.array(z.object({ id: z.string(), seq: z.number(), receivedAt: z.string() })),
  actions: z.object({ declare: held, adjust: held }),
})
export type OrderBalance = z.infer<typeof balanceSchema>

const bookedSchema = z.object({ rowIds: z.array(z.string()), moveIds: z.array(z.string()), ledger: z.object({ posted: z.number(), waiting: z.array(z.string()) }), balance: balanceSchema })
export type BalanceBooked = z.infer<typeof bookedSchema>

export function orderBalance(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderBalance> {
  return api.get(`${base(orderId)}/balance`, { schema: balanceSchema, ...(signal ? { signal } : {}) })
}

export interface DeclareBody {
  version: number
  receiptId?: string | null
  reportedAt?: string
  lines: { kitLineId: string; used: string; returned: string; scrapped: string; reason?: string | null }[]
}

export function declareBalance(api: ApiClient, orderId: string, body: DeclareBody, idempotencyKey: string): Promise<BalanceBooked> {
  return api.post(`${base(orderId)}/balance/declare`, { body, schema: bookedSchema, idempotencyKey })
}

export interface AdjustBody {
  version: number
  kitLineId: string
  used?: string
  returned?: string
  scrapped?: string
  reportedAt?: string
  reason: string
}

export function adjustBalance(api: ApiClient, orderId: string, body: AdjustBody, idempotencyKey: string): Promise<BalanceBooked> {
  return api.post(`${base(orderId)}/balance/adjust`, { body, schema: bookedSchema, idempotencyKey })
}

// ---- the cost on the work order (SCM-146) --------------------------------------------------------------------------------

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(COST_KINDS),
  operation: z.object({ id: z.string(), seq: z.number() }).nullable(),
  receipt: z.object({ id: z.string(), seq: z.number() }).nullable(),
  quantity: z.string(),
  unitPrice: cost(z.string()),
  amount: cost(z.number()),
  currency: z.string(),
  occurredAt: z.string(),
  reason: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  reversedById: z.string().nullable(),
  onWorkOrder: z.boolean(),
  createdAt: z.string(),
})
export type CostEntry = z.infer<typeof entrySchema>

const costOperationSchema = z.object({
  id: z.string(),
  seq: z.number(),
  code: z.string(),
  name: z.string(),
  pricePerPiece: cost(z.string()),
  piecesBackGood: z.number(),
  waitingForInspection: z.number(),
  bookedByFee: z.number(),
  bookable: z.number(),
  earnedFee: cost(z.number()),
})
export type CostOperation = z.infer<typeof costOperationSchema>

export const costSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), currency: z.string(), workOrder: z.object({ id: z.string(), number: z.string(), currency: z.string() }) }),
  operations: z.array(costOperationSchema),
  entries: z.array(entrySchema),
  bridge: z.object({
    earnedFee: cost(z.number()),
    feeAtWorkshopPrice: cost(z.number()),
    transport: cost(z.number()),
    material: cost(z.number()),
    other: cost(z.number()),
    orderCost: cost(z.number()),
    currency: z.string(),
  }),
  workOrder: z.object({ onLedger: cost(z.number()), entries: z.number(), waiting: z.array(z.string()) }),
  invoices: z
    .array(z.object({ invoiceId: z.string(), number: z.string(), status: z.string(), matchStatus: z.string(), currency: z.string(), seq: z.number(), description: z.string(), netAmount: cost(z.number()) }))
    .nullable(),
  actions: z.object({ book: held, reverse: held }),
})
export type OrderCost = z.infer<typeof costSchema>

const costBookedSchema = z.object({ entryId: z.string(), ledger: z.object({ posted: z.number(), waiting: z.array(z.string()) }), view: costSchema })
export type CostBooked = z.infer<typeof costBookedSchema>

export function orderCost(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderCost> {
  return api.get(`${base(orderId)}/cost`, { schema: costSchema, ...(signal ? { signal } : {}) })
}

export interface BookCostBody {
  version: number
  kind: CostKind
  subcontractOperationId?: string | null
  receiptId?: string | null
  quantity?: string
  unitPrice?: string
  reason?: string | null
}

export function bookCost(api: ApiClient, orderId: string, body: BookCostBody, idempotencyKey: string): Promise<CostBooked> {
  return api.post(`${base(orderId)}/costs`, { body, schema: costBookedSchema, idempotencyKey })
}

export function reverseCost(api: ApiClient, orderId: string, entryId: string, body: { version: number; reason: string }, idempotencyKey: string): Promise<CostBooked> {
  return api.post(`${base(orderId)}/costs/${enc(entryId)}/reverse`, { body, schema: costBookedSchema, idempotencyKey })
}

// ---- days out and the open balances (SCM-150, the "Balance open" tile) --------------------------------------------------

const bucketsSchema = z.object({ upTo30: z.string(), upTo60: z.string(), upTo90: z.string(), over90: z.string() })
const ageingRowSchema = z.object({
  location: ref,
  item: z.object({ id: z.string(), code: z.string() }),
  colour: ref.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  onHand: z.string(),
  since: z.string().nullable(),
  daysOut: z.number().nullable(),
  buckets: bucketsSchema,
  longOut: z.boolean(),
})
export type AgeingRow = z.infer<typeof ageingRowSchema>

export const ageingSchema = z.object({
  asOf: z.string(),
  longOutDays: z.number(),
  rows: z.array(ageingRowSchema),
  workshops: z.array(z.object({ workshop: ref, location: ref, lines: z.number(), oldestDaysOut: z.number().nullable(), longOut: z.number() })),
  truncated: z.boolean(),
})
export type Ageing = z.infer<typeof ageingSchema>

export function subcontractorAgeing(api: ApiClient, query: { siteId?: string; partyId?: string; locationId?: string } = {}, signal?: AbortSignal): Promise<Ageing> {
  const clean = Object.fromEntries(Object.entries(query).filter(([, value]) => value))
  return api.get('/purchasing/subcontracting/ageing', { query: clean, schema: ageingSchema, ...(signal ? { signal } : {}) })
}

const openBalanceSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.enum(SUBCONTRACT_ORDER_STATUSES), version: z.number(), workshop: ref, workOrder: z.object({ id: z.string(), number: z.string() }) }),
  kitLines: z.number(),
  openLines: z.number(),
  open: z.array(z.object({ uom: z.string(), quantity: z.string() })),
  oldestSentAt: z.string().nullable(),
  daysOut: z.number().nullable(),
  balanceOpen: z.boolean(),
})
export type OpenBalance = z.infer<typeof openBalanceSchema>

export const balancesSchema = z.object({ asOf: z.string(), items: z.array(openBalanceSchema), counts: z.object({ balanceOpen: z.number(), open: z.number(), longOut: z.number() }) })
export type OpenBalances = z.infer<typeof balancesSchema>

/** The jobs with kit material still open; `open: true` only those whose pieces are all back (the tile's saved filter). */
export function openBalances(api: ApiClient, query: { open?: boolean; siteId?: string; partyId?: string } = {}, signal?: AbortSignal): Promise<OpenBalances> {
  return api.get('/purchasing/subcontracting/balances', {
    query: { ...(query.open ? { open: 'true' } : {}), ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.partyId ? { partyId: query.partyId } : {}) },
    schema: balancesSchema,
    ...(signal ? { signal } : {}),
  })
}
