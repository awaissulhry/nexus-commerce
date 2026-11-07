import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { NOTICE_STATES, SHIP_NOTICE_STATUSES, VERDICTS } from '@nexus/factory-domain/purchasing/ship-notices/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The inbound board and receiving from a ship notice (B-W2b-182; SCM-110, SCM-106; design warehouse.receipts sec:rc-inbound),
 * with the answer's shape checked (zod; unknown fields dropped). The shapes mirror apps/factory-api
 * modules/purchasing/ship-notices/contract.ts (inboundContract, officeNoticeContract, dockNoteContract). No money anywhere.
 * The API's words (the state's, a reason's) come in both languages; the board says its own words from the codes.
 */

const uom = z.enum(UOMS)
const words = z.object({ it: z.string(), en: z.string() })
const state = z.enum(NOTICE_STATES)
const verdict = z.enum(VERDICTS)

const cardSchema = z.object({
  id: z.string(),
  kind: z.enum(['SHIP_NOTICE', 'ORDER']),
  day: z.string(),
  late: z.boolean(),
  siteId: z.string(),
  supplier: z.object({ id: z.string(), name: z.string() }),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }),
  shipNotice: z
    .object({
      id: z.string(),
      number: z.string(),
      state,
      words,
      shipDate: z.string().nullable(),
      carrier: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      parcels: z.number().nullable(),
      supplierRef: z.string().nullable(),
      ddtNumber: z.string().nullable(),
      hides: z.number(),
      verdict,
      supplierNote: z.string().nullable(),
      version: z.number(),
    })
    .nullable(),
  lines: z.number(),
  items: z.array(z.object({ code: z.string(), name: z.string(), quantity: z.string(), uom })),
  dockNote: z.string().nullable(),
})
export type InboundCard = z.infer<typeof cardSchema>

const boardSchema = z.object({
  asOf: z.string(),
  from: z.string(),
  days: z.array(z.string()),
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  cards: z.array(cardSchema),
  complete: z.boolean(),
})
export type InboundBoardData = z.infer<typeof boardSchema>

export function readInbound(api: ApiClient, query: { from?: string | null; days?: number; siteId?: string | null }): Promise<InboundBoardData> {
  return api.get('/inventory/receiving/inbound', { query: { from: query.from ?? undefined, days: query.days, siteId: query.siteId ?? undefined }, schema: boardSchema })
}

const prefillHide = z.object({ supplierCode: z.string(), area: z.string(), areaUom: uom, grade: z.string().nullable(), thicknessMm: z.string().nullable() })
const prefillLot = z.object({ supplierLotRef: z.string().nullable(), dyeBatch: z.string().nullable(), quantity: z.string().nullable(), hides: z.array(prefillHide) })
const prefillSchema = z.object({
  purchaseOrderId: z.string(),
  shipNoticeId: z.string(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  lines: z.array(z.object({ purchaseOrderLineId: z.string(), quantity: z.string().nullable(), lots: z.array(prefillLot) })),
})
export type NoticePrefill = z.infer<typeof prefillSchema>

const officeNoticeSchema = z.object({
  notice: z.object({
    id: z.string(),
    number: z.string().nullable(),
    status: z.enum(SHIP_NOTICE_STATUSES),
    state,
    words,
    purchaseOrder: z.object({ id: z.string(), number: z.string() }),
    shipDate: z.string().nullable(),
    expectedDate: z.string().nullable(),
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    version: z.number(),
    verdict,
    dockNote: z.string().nullable(),
    supplier: z.object({ id: z.string(), name: z.string() }),
  }),
  prefill: prefillSchema.nullable(),
  canReceive: z.boolean(),
  receiveHeld: z.string().nullable(),
})
export type OfficeNotice = z.infer<typeof officeNoticeSchema>

export function readOfficeNotice(api: ApiClient, id: string): Promise<OfficeNotice> {
  return api.get(`/inventory/receiving/ship-notices/${encodeURIComponent(id)}`, { schema: officeNoticeSchema })
}

export function saveDockNote(api: ApiClient, id: string, body: { version: number; dockNote: string | null }, idempotencyKey: string) {
  return api.request('PATCH', `/inventory/receiving/ship-notices/${encodeURIComponent(id)}`, { body, idempotencyKey, schema: z.object({ id: z.string(), dockNote: z.string().nullable(), version: z.number() }) })
}
