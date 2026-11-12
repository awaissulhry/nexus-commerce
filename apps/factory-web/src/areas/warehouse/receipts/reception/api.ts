import { z } from 'zod'
import { DEMAND_KINDS, REPORT_HELD, SERVE_HELD, SERVE_WHY } from '@nexus/factory-domain/inventory/reception-report/rules'
import { UNPLANNED_STATES } from '@nexus/factory-domain/inventory/unplanned/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The calls of the receipt's W2b-5 depth (B-W2b-300 on its own API, apps/factory-api modules/inventory/{reception-report,unplanned}):
 * the reception report (SCM-119: what the goods serve, reserved in one step, sent to the buyer) and goods without a PO (SCM-122:
 * the order named and posted, or the goods sent back). Shapes mirror the API's contracts, checked with zod (unknown fields
 * dropped). The API's English is never drawn as our words: the screens classify a refusal by its path and say their own.
 */

const enc = encodeURIComponent
const tracking = z.enum(['NONE', 'LOT', 'HIDE'])
const item = z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string(), tracking })
const colour = z.object({ id: z.string(), code: z.string(), name: z.string() })
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- the reception report -------------------------------------------------------------------------------------------------

const serve = z.object({
  key: z.string(),
  kind: z.enum(DEMAND_KINDS),
  why: z.enum(SERVE_WHY),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string().nullable() }).nullable(),
  orderLine: z.object({ id: z.string(), number: z.string(), seq: z.number(), status: z.string() }).nullable(),
  needDate: z.string().nullable(),
  pegged: z.string().nullable(),
  open: z.string(),
  reservedHere: z.string(),
  proposed: z.string(),
  lots: z.array(z.object({ lotId: z.string().nullable(), quantity: z.string() })),
  held: z.enum(SERVE_HELD).nullable(),
})
export type Serve = z.infer<typeof serve>

export const reportSchema = z.object({
  receipt: z.object({ id: z.string(), number: z.string(), status: z.string(), companyId: z.string(), siteId: z.string(), purchaseOrder: z.object({ id: z.string(), number: z.string(), partyId: z.string() }).nullable() }),
  held: z.enum(REPORT_HELD).nullable(),
  run: z.object({ id: z.string(), finishedAt: z.string().nullable() }).nullable(),
  buyer: z.object({ id: z.string(), name: z.string() }).nullable(),
  lines: z.array(
    z.object({
      receiptLineId: z.string(),
      seq: z.number(),
      purchaseOrderLineId: z.string().nullable(),
      item,
      colour: colour.nullable(),
      received: z.string(),
      lots: z.array(z.object({ id: z.string().nullable(), code: z.string().nullable(), qualityStatus: z.string().nullable(), free: z.string(), held: z.boolean() })),
      serves: z.array(serve),
      left: z.string(),
    }),
  ),
  proposals: z.number(),
  can: z.object({ reserve: z.boolean(), send: z.boolean() }),
})
export type ReceptionReport = z.infer<typeof reportSchema>
export type ReportLine = ReceptionReport['lines'][number]

const sent = z.object({ messageId: z.string(), buyerTold: z.boolean() })
const reserved = z.object({ reservationIds: z.array(z.string()), skipped: z.array(z.object({ receiptLineId: z.string(), key: z.string(), held: z.string() })), sent: sent.nullable() })
export type Reserved = z.infer<typeof reserved>

export function getReport(api: ApiClient, receiptId: string): Promise<ReceptionReport> {
  return api.get(`/inventory/receipts/${enc(receiptId)}/reception-report`, { schema: reportSchema })
}

export function reserveFromReport(api: ApiClient, receiptId: string, body: { demands: readonly { receiptLineId: string; key: string }[]; tellBuyer: boolean; note?: string | null }, idempotencyKey: string): Promise<Reserved> {
  return api.post(`/inventory/receipts/${enc(receiptId)}/reception-report/reserve`, { body, schema: reserved, idempotencyKey })
}

export function sendReport(api: ApiClient, receiptId: string, body: { note?: string | null }, idempotencyKey: string): Promise<z.infer<typeof sent>> {
  return api.post(`/inventory/receipts/${enc(receiptId)}/reception-report/send`, { body, schema: z.object({ sent }), idempotencyKey }).then((answer) => answer.sent)
}

// ---- goods without a PO ---------------------------------------------------------------------------------------------------

export const unplannedSchema = z.object({
  receipt: z.object({
    id: z.string(),
    number: z.string(),
    status: z.string(),
    state: z.enum(UNPLANNED_STATES),
    version: z.number(),
    companyId: z.string(),
    site: place,
    supplier: z.object({ id: z.string(), code: z.string(), name: z.string() }),
    holding: place.nullable(),
    supplierDdtNumber: z.string().nullable(),
    supplierDdtDate: z.string().nullable(),
    receivedAt: z.string(),
    note: z.string().nullable(),
    purchaseOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
    ddtPhotos: z.array(z.object({ id: z.string(), originalName: z.string() })),
  }),
  lines: z.array(z.object({ id: z.string(), seq: z.number(), item, colour: colour.nullable(), quantity: z.string(), uom: z.string(), baseQuantity: z.string(), hideCount: z.number().nullable(), note: z.string().nullable() })),
  buyerTask: z.object({ id: z.string(), title: z.string(), status: z.string(), dueDate: z.string().nullable(), assignee: z.object({ id: z.string(), name: z.string() }).nullable() }).nullable(),
  orders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      version: z.number(),
      requestedDate: z.string().nullable(),
      lines: z.array(z.object({ id: z.string(), seq: z.number(), item, colour: colour.nullable(), quantity: z.string(), uom: z.string(), openBase: z.string(), tolerancePct: z.string().nullable() })),
      fits: z.array(z.object({ receiptLineId: z.string(), purchaseOrderLineIds: z.array(z.string()) })),
    }),
  ),
  can: z.object({ decide: z.boolean(), askBuyer: z.boolean() }),
})
export type Unplanned = z.infer<typeof unplannedSchema>
export type UnplannedOrder = Unplanned['orders'][number]

export function getUnplanned(api: ApiClient, receiptId: string): Promise<Unplanned> {
  return api.get(`/inventory/unplanned/${enc(receiptId)}`, { schema: unplannedSchema })
}

export interface NameLine {
  readonly receiptLineId: string
  readonly purchaseOrderLineId: string
  readonly supplierLotRef?: string | null
  readonly hideAreas?: readonly string[]
}

export function nameOrder(api: ApiClient, receiptId: string, body: { version: number; purchaseOrderId: string; lines: readonly NameLine[] }, idempotencyKey: string) {
  return api.post(`/inventory/unplanned/${enc(receiptId)}/order`, { body, schema: z.object({ receiptId: z.string(), number: z.string(), purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }), moves: z.number() }), idempotencyKey })
}

export function sendBack(api: ApiClient, receiptId: string, body: { version: number; reason: string }, idempotencyKey: string) {
  return api.post(`/inventory/unplanned/${enc(receiptId)}/return`, { body, schema: z.object({ receiptId: z.string(), status: z.string() }), idempotencyKey })
}

export function askBuyer(api: ApiClient, receiptId: string, body: { version: number }, idempotencyKey: string) {
  return api.post(`/inventory/unplanned/${enc(receiptId)}/buyer`, { body, schema: z.object({ buyerTaskId: z.string().nullable() }), idempotencyKey })
}
