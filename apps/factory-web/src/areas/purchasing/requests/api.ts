import { z } from 'zod'
import { SET_ASIDE_REASONS } from '@nexus/factory-domain/planning/decisions'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { REORDER_METHODS, REQUEST_HOLDS, REQUEST_KINDS, REQUEST_STATUSES, REQUEST_WARNINGS } from '@nexus/factory-domain/purchasing/requests/requests'
import { SOURCE_PREFERENCES } from '@nexus/factory-domain/purchasing/sources/sources'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Purchasing › Requests to buy (SCR-236; B-W2a-10's API, apps/factory-api modules/purchasing/requests
 * contract.ts): the queue, its tiles, one request with its approved sources, "Draft POs for n" (preview, then convert in
 * one command) and "Reject with reason" (planning's set-aside of the plan lines). Answers are checked with zod (unknown
 * fields dropped); the enum lists are factory-domain's. Prices and values are the cost grain: absent for a person without
 * it (the screen then draws no such column). The API's English (`why`, holds' and warnings' `message`) is never drawn:
 * the screen says its own words from the codes and numbers.
 */

const uom = z.enum(UOMS)
export type Uom = (typeof UOMS)[number]
export const KINDS = REQUEST_KINDS
export type RequestKind = (typeof REQUEST_KINDS)[number]
export const STATUSES = REQUEST_STATUSES
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
export const HOLDS = REQUEST_HOLDS
export type HoldCode = (typeof REQUEST_HOLDS)[number]
export const WARNINGS = REQUEST_WARNINGS
export type WarningCode = (typeof REQUEST_WARNINGS)[number]
export const SET_ASIDE = SET_ASIDE_REASONS
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number]

const coded = <T extends readonly [string, ...string[]]>(codes: T) => z.object({ code: z.enum(codes), message: z.string() })
const step = z.object({ rule: z.string(), quantity: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const requestSchema = z.object({
  id: z.string(),
  kind: z.enum(REQUEST_KINDS),
  refId: z.string(),
  version: z.number(),
  status: z.enum(REQUEST_STATUSES),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom, requiresCrViTest: z.boolean() }),
  colour: ref.nullable(),
  needDate: z.string(),
  needWeek: z.string(),
  orderBy: z.object({ date: z.string(), leadTimeDays: z.number().nullable(), passed: z.boolean(), closedDaysSkipped: z.number() }),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  baseUom: uom,
  estimatedHides: z.number().nullable(),
  quantityFrom: z.enum(['FIRM', 'SOURCE', 'PLAN', 'ITEM']),
  rounding: z.array(step),
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string() }).nullable(),
  supplierFrom: z.enum(['CHOSEN', 'FIRM', 'SITE', 'SOURCE', 'DEFAULT']).nullable(),
  sourceId: z.string().nullable(),
  approvedSuppliers: z.number(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  currency: z.string().nullable(),
  unitPrice: z.string().nullable().optional(),
  expectedAmount: z.number().nullable().optional(),
  hold: coded(REQUEST_HOLDS).nullable(),
  warnings: z.array(coded(REQUEST_WARNINGS)),
  plan: z
    .object({
      runId: z.string(),
      runStatus: z.string(),
      runStartedAt: z.string(),
      trigger: z.string(),
      why: z.string(),
      grossQuantity: z.string(),
      usableStock: z.string(),
      heldStock: z.string(),
      onOrder: z.string(),
      netQuantity: z.string(),
      suggestedQuantity: z.string(),
      suggestedUom: uom,
      orders: z.array(z.object({ id: z.string(), number: z.string() })),
      workOrders: z.array(z.string()),
      firm: z.boolean(),
      decidedAt: z.string().nullable(),
      setAside: z.object({ reason: z.enum(SET_ASIDE_REASONS), note: z.string().nullable() }).nullable(),
      purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
    })
    .nullable(),
  reorder: z
    .object({
      method: z.enum(REORDER_METHODS),
      position: z.string(),
      usable: z.string(),
      onOrder: z.string(),
      reserved: z.string(),
      level: z.string(),
      triggered: z.boolean(),
      quantity: z.string(),
      why: z.string(),
      note: z.string().nullable(),
    })
    .nullable(),
})
export type BuyRequest = z.infer<typeof requestSchema>

const listSchema = z.object({ asOf: z.string(), requests: z.array(requestSchema), matching: z.number(), nextCursor: z.string().nullable() })
export type RequestPage = z.infer<typeof listSchema>

export interface RequestQuery {
  siteId?: string | null
  kind?: RequestKind | null
  status?: RequestStatus | 'ALL'
  needBy?: string | null
  held?: boolean | null
  q?: string
  cursor?: string | null
  limit?: number
}

/** The API's own query of a request list (the tiles and saved views are these filters). */
export function requestParams(query: RequestQuery): Record<string, string | number | undefined> {
  return {
    siteId: query.siteId ?? undefined,
    kind: query.kind ?? undefined,
    status: query.status ?? undefined,
    needBy: query.needBy ?? undefined,
    held: query.held === true ? 'true' : query.held === false ? 'false' : undefined,
    q: query.q?.trim() || undefined,
    cursor: query.cursor ?? undefined,
    limit: query.limit ?? 200,
  }
}

export function listRequests(api: ApiClient, query: RequestQuery, signal?: AbortSignal): Promise<RequestPage> {
  return api.get('/purchasing/requests', { query: requestParams(query), schema: listSchema, signal })
}

const countsSchema = z.object({ asOf: z.string(), open: z.number(), needWithin14Days: z.number(), waitingApproval: z.null(), convertedToday: z.number() })
export type RequestCounts = z.infer<typeof countsSchema>

export function requestCounts(api: ApiClient, query: { siteId?: string | null; kind?: RequestKind | null }, signal?: AbortSignal): Promise<RequestCounts> {
  return api.get('/purchasing/requests/counts', { query: { siteId: query.siteId ?? undefined, kind: query.kind ?? undefined }, schema: countsSchema, signal })
}

const sourceSchema = z.object({
  id: z.string(),
  partyId: z.string(),
  supplier: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  preference: z.enum(SOURCE_PREFERENCES),
  purchaseUom: uom,
  unitPrice: z.string().nullable().optional(),
  currency: z.string(),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  supplierArticleCode: z.string().nullable(),
})
export type RequestSource = z.infer<typeof sourceSchema>
const onOrderSchema = z.object({ purchaseOrderId: z.string(), number: z.string(), status: z.string(), openQuantity: z.string() })
export type OnOrderLine = z.infer<typeof onOrderSchema>
const detailSchema = z.object({ request: requestSchema, sources: z.array(sourceSchema), onOrder: z.array(onOrderSchema) })
export type RequestDetail = z.infer<typeof detailSchema>

/** One request (`plan:<id>` → GET …/plan/<id>), with the approved sources that reach it and a reorder row's open PO lines. */
export function getRequest(api: ApiClient, kind: RequestKind, refId: string, signal?: AbortSignal): Promise<RequestDetail> {
  return api.get(`/purchasing/requests/${kind === 'PLAN' ? 'plan' : 'reorder'}/${encodeURIComponent(refId)}`, { schema: detailSchema, signal })
}

export interface ConvertBody {
  requests: { kind: RequestKind; id: string; version: number; supplierId?: string }[]
  into?: { supplierId: string; siteId?: string; purchaseOrderId: string | null }[]
}

const cardLineSchema = z.object({
  requestId: z.string(),
  item: ref,
  colour: ref.nullable(),
  quantity: z.string(),
  uom,
  needDate: z.string(),
  unitPrice: z.string().nullable().optional(),
  expectedAmount: z.number().nullable().optional(),
  warnings: z.array(coded(REQUEST_WARNINGS)),
})
const draftRef = z.object({ id: z.string(), number: z.string(), lineCount: z.number() })
const cardSchema = z.object({
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string() }),
  currency: z.string(),
  into: z.enum(['EXISTING', 'NEW']),
  draft: draftRef.nullable(),
  openDraft: draftRef.nullable(),
  lines: z.array(cardLineSchema),
  expectedAmount: z.number().nullable().optional(),
  mayDraft: z.boolean(),
})
export type DraftCard = z.infer<typeof cardSchema>
const previewSchema = z.object({ cards: z.array(cardSchema), held: z.array(z.object({ requestId: z.string(), code: z.enum(REQUEST_HOLDS), message: z.string() })) })
export type ConvertPreview = z.infer<typeof previewSchema>

/** What "Draft POs for n" would make: one card per supplier and delivery site. Nothing is written. */
export function previewConversion(api: ApiClient, body: ConvertBody, signal?: AbortSignal): Promise<ConvertPreview> {
  return api.post('/purchasing/requests/preview', { body, schema: previewSchema, signal })
}

const convertedSchema = z.object({
  orders: z.array(z.object({ id: z.string(), number: z.string(), created: z.boolean(), companyId: z.string(), siteId: z.string(), supplierId: z.string(), lineIds: z.array(z.string()), lineCount: z.number() })),
  lines: z.array(z.object({ requestId: z.string(), purchaseOrderId: z.string(), purchaseOrderLineId: z.string() })),
})
export type Converted = z.infer<typeof convertedSchema>

/** Draft the requests into purchase orders in ONE command (the dialog's own Idempotency-Key: a resend answers the same). */
export function convertRequests(api: ApiClient, body: ConvertBody, idempotencyKey: string): Promise<Converted> {
  return api.post('/purchasing/requests/convert', { body, schema: convertedSchema, idempotencyKey })
}

const decidedSchema = z.object({ runId: z.string(), decision: z.string(), lines: z.array(z.object({ id: z.string(), version: z.number() })) })

/** "Reject with reason" of plan rows = planning's set-aside of their plan lines (planning.decide). */
export function rejectPlanLines(api: ApiClient, lines: readonly { id: string; version: number }[], reason: SetAsideReason, note: string | null, idempotencyKey: string = newIdempotencyKey()) {
  return api.post('/planning/requirements/set-aside', { body: { lines, reason, ...(note?.trim() ? { note: note.trim() } : {}) }, schema: decidedSchema, idempotencyKey })
}
