import { z } from 'zod'
import { DIFFERENCES, GOODS_RECEIPT_STATUSES, HOLD_REASONS, RECEIPT_NOTE_CODES, REVERSAL_BLOCKERS } from '@nexus/factory-domain/inventory/receipts/rules'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Receipts (SCR-063) and the receiving of goods with their lots and hides one by one (SCR-061/062), with
 * the answer's shape checked (zod; unknown fields are dropped). The shapes mirror apps/factory-api
 * modules/inventory/receipts/contract.ts; the enum lists are factory-domain's. Values are the cost grain (absent without
 * it). The API's English (notes, lot words, blocker messages) is never drawn: the screens say their own words from the
 * codes and the record's facts.
 */

const uom = z.enum(UOMS)
export type Uom = z.infer<typeof uom>
export const RECEIPT_STATUSES = GOODS_RECEIPT_STATUSES
export type ReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number]
const tracking = z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL'])
export type Tracking = z.infer<typeof tracking>
const value = z.object({ currency: z.string(), valueAmount: z.number() }).nullable().optional()

const rowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(GOODS_RECEIPT_STATUSES),
  companyId: z.string(),
  siteId: z.string(),
  supplier: z.object({ id: z.string(), name: z.string() }),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  receivedAt: z.string(),
  lines: z.number(),
  lots: z.number(),
  lotsReleased: z.number(),
  hides: z.number(),
  quantities: z.array(z.object({ uom, baseQuantity: z.string() })),
  postedAt: z.string().nullable(),
  /** B-W2a-31: its discrepancies — every one, not closed yet, not reported yet (absent from an older API: none). */
  discrepancies: z.object({ count: z.number(), open: z.number(), unsent: z.number() }).optional(),
  value,
})
export type ReceiptRow = z.infer<typeof rowSchema>

export interface ReceiptQuery {
  status?: ReceiptStatus | null
  waiting?: boolean
  /** B-W2a-31: only receipts with a discrepancy not closed yet. */
  discrepancies?: boolean
  postedFrom?: string | null
  q?: string
  siteId?: string | null
  cursor?: string | null
}

export function listReceipts(api: ApiClient, query: ReceiptQuery, signal?: AbortSignal) {
  return api.get('/inventory/receipts', {
    query: {
      status: query.status ?? undefined,
      waiting: query.waiting ? 'true' : undefined,
      discrepancies: query.discrepancies ? 'open' : undefined,
      postedFrom: query.postedFrom ?? undefined,
      q: query.q?.trim() || undefined,
      siteId: query.siteId ?? undefined,
      cursor: query.cursor ?? undefined,
      limit: 50,
    },
    schema: z.object({ receipts: z.array(rowSchema), nextCursor: z.string().nullable() }),
    signal,
  })
}

const countsSchema = z.object({ counts: z.object({ posted: z.number(), reversed: z.number(), waiting: z.number(), postedSince: z.number().nullable(), discrepanciesOpen: z.number().optional() }) })
export type ReceiptCounts = z.infer<typeof countsSchema>['counts']

export async function countReceipts(api: ApiClient, postedFrom: string, siteId?: string | null, signal?: AbortSignal): Promise<ReceiptCounts> {
  return (await api.get('/inventory/receipts/counts', { query: { postedFrom, siteId: siteId ?? undefined }, schema: countsSchema, signal })).counts
}

const expectedSchema = z.object({
  purchaseOrderId: z.string(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  version: z.number(),
  siteId: z.string(),
  supplier: z.object({ id: z.string(), name: z.string() }),
  purchaseOrderLineId: z.string(),
  seq: z.number(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), tracking, baseUom: uom }),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  expected: z.string(),
  received: z.string(),
  open: z.string(),
  tolerancePct: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  oneDyeBatch: z.boolean(),
  requiresCrViTest: z.boolean(),
  needDate: z.string(),
})
export type ExpectedLine = z.infer<typeof expectedSchema>

export async function expectedLines(api: ApiClient, query: { siteId?: string | null; purchaseOrderId?: string | null }, signal?: AbortSignal): Promise<ExpectedLine[]> {
  return (await api.get('/inventory/receipts/expected', { query: { siteId: query.siteId ?? undefined, purchaseOrderId: query.purchaseOrderId ?? undefined, limit: 500 }, schema: z.object({ lines: z.array(expectedSchema) }), signal })).lines
}

const lotSchema = z.object({
  id: z.string(),
  code: z.string(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: z.string().nullable(),
  qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']),
  requiresCrViTest: z.boolean(),
  crViStatus: z.enum(CR_VI_STATUSES),
  crViLimitMgKg: z.string().nullable(),
  holds: z.array(z.enum(HOLD_REASONS)),
  baseQuantity: z.string(),
  hideCount: z.number(),
})
export type ReceiptLot = z.infer<typeof lotSchema>

const differenceSchema = z.object({ kind: z.enum(DIFFERENCES), expected: z.string(), receivedBefore: z.string(), after: z.string(), open: z.string(), difference: z.string(), tolerancePct: z.string(), upTo: z.string() })

const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  purchaseOrderLineId: z.string().nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), tracking, baseUom: uom }),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  hideCount: z.number().nullable(),
  note: z.string().nullable(),
  orderLine: z
    .object({
      seq: z.number(),
      quantity: z.string(),
      uom,
      baseQuantity: z.string(),
      expected: z.string(),
      received: z.string(),
      open: z.string(),
      tolerancePct: z.string().nullable(),
      estimatedHides: z.number().nullable(),
      oneDyeBatch: z.boolean(),
      requiresCrViTest: z.boolean(),
    })
    .nullable(),
  difference: differenceSchema.nullable(),
  lots: z.array(lotSchema),
  /** B-W2a-31 (SCM-123): received in the supplier's unit (a roll, a box) with its factor; null: in the order line's unit. */
  received: z.object({ quantity: z.string(), uom, factor: z.string() }).nullable().optional(),
  value,
})
export type ReceiptLine = z.infer<typeof lineSchema>

const blockerSchema = z.object({ code: z.enum(REVERSAL_BLOCKERS), where: z.string(), items: z.array(z.object({ kind: z.enum(['LOT', 'HIDE']), code: z.string() })) })
export type ReversalBlocker = z.infer<typeof blockerSchema>

export const receiptSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(GOODS_RECEIPT_STATUSES),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  supplier: z.object({ id: z.string(), name: z.string() }),
  purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES), version: z.number() }).nullable(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  /** B-W2b-14: the latest correction of the supplier DDT number/date on the posted receipt (when, who, why). */
  supplierDdtCorrection: z.object({ at: z.string(), byId: z.string().nullable(), reason: z.string() }).nullable().default(null),
  receivedAt: z.string(),
  note: z.string().nullable(),
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  postedAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
  reversalReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  summary: z.object({ lines: z.number(), lots: z.number(), lotsInQuarantine: z.number(), lotsReleased: z.number(), hides: z.number(), quantities: z.array(z.object({ uom, baseQuantity: z.string() })) }),
  lines: z.array(lineSchema),
  /** B-W2a-31 (SCM-115): the supplier's delivery note photographed (the receipt's PHOTO files). */
  ddtPhotos: z.array(z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string(), createdAt: z.string() })).default([]),
  /** B-W2a-31 (SCM-118): its discrepancies — every one, not closed yet, not reported yet. */
  discrepancies: z.object({ count: z.number(), open: z.number(), unsent: z.number() }).default({ count: 0, open: 0, unsent: 0 }),
  reversal: z.object({ possible: z.boolean(), location: z.string().nullable(), blockers: z.array(blockerSchema) }).nullable(),
  value,
})
export type Receipt = z.infer<typeof receiptSchema>

export async function getReceipt(api: ApiClient, id: string, signal?: AbortSignal): Promise<Receipt> {
  return (await api.get(`/inventory/receipts/${encodeURIComponent(id)}`, { schema: z.object({ receipt: receiptSchema }), signal })).receipt
}

const hideSchema = z.object({
  id: z.string(),
  code: z.string(),
  supplierCode: z.string().nullable(),
  area: z.string(),
  areaUom: uom,
  baseArea: z.string(),
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  defects: z.string().nullable(),
  state: z.enum(['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED']),
  onHand: z.string(),
  locationId: z.string().nullable(),
})
export type ReceiptHide = z.infer<typeof hideSchema>
const lotWithHidesSchema = lotSchema.extend({ lineSeq: z.number(), itemId: z.string(), itemColourId: z.string().nullable(), hides: z.array(hideSchema), onHand: z.string() })
export type LotWithHides = z.infer<typeof lotWithHidesSchema>

export async function receiptLots(api: ApiClient, id: string, signal?: AbortSignal): Promise<LotWithHides[]> {
  return (await api.get(`/inventory/receipts/${encodeURIComponent(id)}/lots`, { schema: z.object({ lots: z.array(lotWithHidesSchema) }), signal })).lots
}

export interface HideBody {
  supplierCode?: string
  area: string
  areaUom?: string
  grade?: string
  shade?: string
  thicknessMm?: string
  defects?: string
}
export interface LotBody {
  supplierLotRef?: string
  dyeBatch?: string
  shade?: string
  quantity?: string
  holdReason?: string
  hides?: HideBody[]
}
export interface LineBody {
  purchaseOrderLineId: string
  quantity?: string
  lots?: LotBody[]
  differenceReason?: string
  note?: string
}
export interface ReceiptBody {
  purchaseOrderId: string
  supplierDdtNumber?: string
  supplierDdtDate?: string
  receivedAt?: string
  note?: string
  lines: LineBody[]
}

const recordedSchema = z.object({ receipt: receiptSchema, notes: z.array(z.object({ code: z.enum(RECEIPT_NOTE_CODES), seq: z.number().nullable() })) })
export type Recorded = z.infer<typeof recordedSchema>

export function recordReceipt(api: ApiClient, body: ReceiptBody, idempotencyKey: string): Promise<Recorded> {
  return api.post('/inventory/receipts', { body, schema: recordedSchema, idempotencyKey })
}

export function reverseReceipt(api: ApiClient, id: string, version: number, reason: string, idempotencyKey: string) {
  return api.post(`/inventory/receipts/${encodeURIComponent(id)}/reverse`, { body: { version, reason }, schema: z.object({ receipt: receiptSchema }), idempotencyKey })
}
