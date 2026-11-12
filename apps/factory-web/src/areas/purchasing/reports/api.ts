import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Every call of Purchasing › Reports (SCR-255, B-W2b-350), with the answer's shape checked (zod; unknown fields are dropped). The
 * spend mirrors apps/factory-api modules/purchasing/reports/contract.ts; the late lines are the expediting worklist (GET
 * /purchasing/expediting, B-W2b-305) and the chase its order routes (GET|POST /purchasing/orders/:id/chase). The lists mirror
 * factory-domain purchasing/reports/rules and purchasing/expediting/worklist (reports.vitest.test.ts holds them equal). Every
 * amount is the cost grain's: the API leaves it out for a reader without it (so each is optional here). Nothing names a person.
 */

export const SPEND_GROUPS = ['supplier', 'category', 'material', 'company', 'month'] as const
export type SpendGroup = (typeof SPEND_GROUPS)[number]
export const SPEND_KINDS = ['production', 'samples'] as const
export type SpendKind = (typeof SPEND_KINDS)[number]
export const EXPEDITE_REASONS = ['LATE', 'NOT_CONFIRMED', 'CONFIRMED_LATE'] as const
export type ExpediteReason = (typeof EXPEDITE_REASONS)[number]

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const amount = z.number().nullable().optional()
const head = {
  company: ref.nullable(),
  site: ref.nullable(),
  from: z.string(),
  to: z.string(),
  today: z.string(),
  asOf: z.string(),
}
const sight = z.object({ orders: z.boolean(), values: z.boolean() })
export type Sight = z.infer<typeof sight>
const counts = { orders: z.number(), lines: z.number(), sampleOrders: z.number(), sampleLines: z.number() }
const figures = {
  byCurrency: z.array(z.object({ currency: z.string(), production: amount, samples: amount })),
  production: amount,
  samples: amount,
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
  ...counts,
}
const figuresSchema = z.object(figures)
export type SpendFigures = z.infer<typeof figuresSchema>
const monthFigures = z.object({ month: z.string(), production: amount, samples: amount, currency: z.string().nullable(), ...counts })
export type MonthFigures = z.infer<typeof monthFigures>
const spendGroup = z.object({ key: z.string(), code: z.string().nullable(), name: z.string(), share: z.string().nullable().optional(), ...figures, months: z.array(monthFigures) })
export type SpendGroupRow = z.infer<typeof spendGroup>
const spendSchema = z.object({
  ...head,
  sight,
  by: z.enum(SPEND_GROUPS),
  months: z.array(z.string()),
  companyCurrency: z.string().nullable(),
  all: figuresSchema,
  groups: z.array(spendGroup),
  more: z.number(),
  complete: z.boolean(),
})
export type Spend = z.infer<typeof spendSchema>

const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'SENT', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
const spendLine = z.object({
  lineId: z.string(),
  seq: z.number(),
  purchaseOrderId: z.string(),
  number: z.string(),
  status: z.enum(PO_STATUSES),
  kind: z.enum(SPEND_KINDS),
  placedOn: z.string(),
  supplier: ref,
  item: ref,
  category: z.string(),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  ended: z.enum(['CLOSED_SHORT']).nullable(),
  spend: amount,
  currency: z.string(),
})
export type SpendLine = z.infer<typeof spendLine>
const spendLinesSchema = z.object({ ...head, sight, by: z.enum(SPEND_GROUPS), key: z.string(), code: z.string().nullable(), name: z.string(), figures: figuresSchema, lines: z.array(spendLine), more: z.number() })
export type SpendLines = z.infer<typeof spendLinesSchema>

const blocked = z.object({
  kind: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string().nullable() }).nullable(),
  salesOrder: z.object({ id: z.string(), number: z.string(), promiseDate: z.string().nullable() }).nullable(),
  size: z.string().nullable(),
  demandDate: z.string(),
  quantity: z.string(),
  lateBy: z.number(),
})
export type Blocked = z.infer<typeof blocked>
const lateRow = z.object({
  lineId: z.string(),
  seq: z.number(),
  purchaseOrderId: z.string(),
  number: z.string(),
  status: z.enum(PO_STATUSES),
  revision: z.number(),
  version: z.number(),
  companyId: z.string(),
  siteId: z.string(),
  partyId: z.string(),
  supplierName: z.string(),
  item: z.object({ code: z.string(), name: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  baseUom: z.string().nullable(),
  outstandingBase: z.string(),
  needDate: z.string(),
  confirmedDate: z.string().nullable(),
  expectedDate: z.string(),
  nextDelivery: z.object({ seq: z.number(), needDate: z.string(), confirmedDate: z.string().nullable() }).nullable(),
  daysLate: z.number(),
  confirmedLaterBy: z.number(),
  confirmBy: z.string().nullable(),
  reasons: z.array(z.enum(EXPEDITE_REASONS)),
  blocks: z.object({ entries: z.array(blocked), salesOrdersAtRisk: z.number(), workOrdersAtRisk: z.number(), earliestPromise: z.string().nullable() }),
})
export type LateRow = z.infer<typeof lateRow>
const lateSchema = z.object({
  today: z.string(),
  complete: z.boolean(),
  tiles: z.object({ late: z.number(), notConfirmed: z.number(), confirmedLate: z.number(), atRisk: z.number(), salesOrdersAtRisk: z.number() }),
  plans: z.array(z.object({ siteId: z.string(), runId: z.string().nullable(), finishedAt: z.string().nullable() })),
  rows: z.array(lateRow),
  nextCursor: z.string().nullable(),
})
export type Late = z.infer<typeof lateSchema>

const chasePreviewSchema = z.object({
  chase: z.object({
    orderId: z.string(),
    version: z.number(),
    allowed: z.boolean(),
    why: z.string().nullable(),
    lines: z.array(z.object({ lineId: z.string(), seq: z.number(), label: z.string(), needDate: z.string(), confirmedDate: z.string().nullable(), expectedDate: z.string(), daysLate: z.number(), confirmedLaterBy: z.number(), reasons: z.array(z.enum(EXPEDITE_REASONS)) })),
    recipient: z.object({ contactId: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
    language: z.enum(['it', 'en']),
    subject: z.string(),
    body: z.string(),
  }),
})
export type ChasePreview = z.infer<typeof chasePreviewSchema>['chase']
const chaseSentSchema = z.object({ chase: z.object({ lineIds: z.array(z.string()), to: z.string(), emailId: z.string(), sentAt: z.string(), language: z.enum(['it', 'en']) }) })
export type ChaseSent = z.infer<typeof chaseSentSchema>['chase']

export interface ReportsScope {
  readonly siteId: string | null
  readonly from: string | null
  readonly to: string | null
}

const scopeQuery = (scope: ReportsScope): Record<string, string> => {
  const query: Record<string, string> = {}
  if (scope.siteId) query.siteId = scope.siteId
  if (scope.from) query.from = scope.from
  if (scope.to) query.to = scope.to
  return query
}

/** GET /purchasing/reports/spend — the spend by one group (sec spend). */
export const getSpend = (api: ApiClient, scope: ReportsScope, by: SpendGroup, signal?: AbortSignal) => api.get('/purchasing/reports/spend', { query: { ...scopeQuery(scope), by }, schema: spendSchema, signal })

/** GET /purchasing/reports/spend/lines — the purchase order lines behind one bar (pop drill). */
export const getSpendLines = (api: ApiClient, scope: ReportsScope, by: SpendGroup, key: string, signal?: AbortSignal) =>
  api.get('/purchasing/reports/spend/lines', { query: { ...scopeQuery(scope), by, key }, schema: spendLinesSchema, signal })

export interface LateQuery {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly reason: ExpediteReason | null
  readonly cursor?: string | null
  /** Rows per page (default 50; the print view reads 200, the route's most). */
  readonly limit?: number
}

/** GET /purchasing/expediting — the late lines and what they block, ranked by the customer orders they put at risk (sec late). */
export function getLate(api: ApiClient, query: LateQuery, signal?: AbortSignal) {
  const terms: Record<string, string> = { limit: String(query.limit ?? 50) }
  if (query.companyId) terms.companyId = query.companyId
  if (query.siteId) terms.siteId = query.siteId
  if (query.reason) terms.reason = query.reason
  if (query.cursor) terms.cursor = query.cursor
  return api.get('/purchasing/expediting', { query: terms, schema: lateSchema, signal })
}

/** GET /purchasing/orders/:id/chase — what a chase of the order would say, and to whom (or why not). */
export const getChasePreview = (api: ApiClient, orderId: string, language?: 'it' | 'en') => api.get(`/purchasing/orders/${orderId}/chase`, { query: language ? { language } : {}, schema: chasePreviewSchema })

/** POST /purchasing/orders/:id/chase — the mail to the supplier (purchasing.send), for some of its lines. */
export const postChase = (api: ApiClient, orderId: string, body: { version: number; lineIds?: readonly string[]; message?: string | null }, idempotencyKey: string) =>
  api.post(`/purchasing/orders/${orderId}/chase`, { body: { version: body.version, ...(body.lineIds && body.lineIds.length > 0 ? { lineIds: [...body.lineIds] } : {}), ...(body.message ? { message: body.message } : {}) }, schema: chaseSentSchema, idempotencyKey })
