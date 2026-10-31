import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * Subcontract kits' calls (apps/factory-api modules/purchasing/subcontracting floor.ts, B-W2a-76; the floor at its own site:
 * purchasing.subcontract.kit to send, .receive to take goods back): the site's orders to send or to receive (or the one a
 * scanned number names), one order's kit, the send with its DDT, the receipt and the DDT's PDF. The reasons a rejected bundle
 * may carry are read by the floor's one reason picker (reasons/api, the REWORK list). No fee, price or value anywhere.
 */

const codeName = z.object({ code: z.string(), name: z.string() })
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const codeRef = z.object({ id: z.string(), code: z.string() })
const status = z.enum(['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'])
export type KitOrderStatus = z.infer<typeof status>

const row = z.object({
  id: z.string(),
  number: z.string(),
  status,
  workshop: codeName,
  workOrder: z.object({ number: z.string(), style: codeName }),
  expectedBackDate: z.string().nullable(),
  late: z.boolean(),
  pieces: z.object({ ordered: z.number(), sent: z.number(), atWorkshop: z.number(), back: z.number() }),
  kit: z.object({ planned: z.number(), sent: z.number() }),
})
export type KitRow = z.infer<typeof row>

const kitLine = z.object({
  id: z.string(),
  seq: z.number(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string(), tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  lot: codeRef.nullable(),
  hide: codeRef.nullable(),
  quantity: z.string(),
  uom: z.string(),
  baseQuantity: z.string(),
  status: z.enum(['PLANNED', 'SENT', 'CANCELLED']),
  sentAt: z.string().nullable(),
  ddtNumber: z.string().nullable(),
  sources: z.array(z.object({ location: place, lot: codeRef.nullable(), hide: codeRef.nullable(), available: z.string(), covers: z.boolean() })),
  from: place.nullable(),
  atWorkshop: z.string().nullable(),
})
export type KitLine = z.infer<typeof kitLine>

const bundle = z.object({
  id: z.string(),
  code: z.string(),
  replacedCodes: z.array(z.string()),
  workOrderSizeId: z.string(),
  colourway: z.string(),
  size: z.string(),
  part: z.string().nullable(),
  quantity: z.number(),
  sent: z.boolean(),
  back: z.array(z.object({ operationId: z.string(), good: z.number(), defective: z.number(), scrapped: z.number() })),
})
export type KitBundle = z.infer<typeof bundle>

const order = z.object({
  id: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  workshop: codeName,
  location: codeName,
  workOrder: z.object({ number: z.string(), style: codeName }),
  expectedBackDate: z.string().nullable(),
  late: z.boolean(),
  operations: z.array(z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), pieces: z.number(), sent: z.number(), backGood: z.number(), backDefective: z.number(), scrapped: z.number(), atWorkshop: z.number(), cells: z.array(z.string()) })),
  kitLines: z.array(kitLine),
  bundles: z.array(bundle),
  places: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() })),
  ddts: z.array(z.object({ id: z.string(), number: z.string(), documentDate: z.string(), cancelled: z.boolean(), pdf: z.boolean() })),
  actions: z.object({ send: z.string().nullable(), receive: z.string().nullable() }),
})
export type KitOrder = z.infer<typeof order>

export type KitMode = 'send' | 'receive'

const list = z.object({ serverTime: z.string(), orders: z.array(row), found: z.object({ id: z.string(), number: z.string(), status }).nullable() })
export type KitList = z.infer<typeof list>

/** GET /purchasing/subcontracting/kits?mode=&code= */
export function fetchKits(api: ApiClient, mode: KitMode, code?: string): Promise<TaskOutcome<KitList>> {
  return floorRead(api, '/purchasing/subcontracting/kits', { query: { mode, ...(code ? { code } : {}) }, schema: list })
}

/** GET /purchasing/subcontracting/kits/:id */
export function fetchKit(api: ApiClient, orderId: string): Promise<TaskOutcome<KitOrder>> {
  return floorRead(api, `/purchasing/subcontracting/kits/${seg(orderId)}`, { schema: z.object({ order }) }).then((answer) => (answer.ok ? { ok: true, value: answer.value.order } : answer))
}

export type TransportBy = 'SENDER' | 'RECIPIENT'

export interface SendBody {
  version: number
  lines: { lineId: string; fromLocationId: string; lotId?: string | null; hideId?: string | null }[]
  bundles: { bundleId: string }[]
  ddt: { transportBy: TransportBy; packages: number; grossWeightKg: string; appearance?: string | null }
}

const sendAnswer = z.object({ order, ddt: z.object({ id: z.string(), number: z.string(), pdf: z.boolean(), pdfProblem: z.string().nullable() }).nullable() })
export type SendAnswer = z.infer<typeof sendAnswer>

/** POST …/kits/:id/send — ONE command with the DDT; the key is kept for a retry of the same send. */
export function sendKit(api: ApiClient, orderId: string, body: SendBody, idempotencyKey: string): Promise<TaskOutcome<SendAnswer>> {
  return floorWrite(api, 'POST', `/purchasing/subcontracting/kits/${seg(orderId)}/send`, { body, schema: sendAnswer, idempotencyKey })
}

export interface ReceiveBody {
  version: number
  lines: { operationId: string; bundleId?: string; good: number; defective: number; scrapped: number; reason?: string | null }[]
  returns: { itemId: string; itemColourId?: string | null; lotId?: string | null; hideId?: string | null; quantity: string; uom?: string; toLocationId: string }[]
  supplierDdt?: { number: string } | null
}

const receiveAnswer = z.object({ order, receipt: z.object({ id: z.string(), receivedAt: z.string(), good: z.number(), defective: z.number(), scrapped: z.number(), bundles: z.number(), returned: z.number() }) })
export type ReceiveAnswer = z.infer<typeof receiveAnswer>

/** POST …/kits/:id/receive — ONE receipt; the key is kept for a retry of the same receipt. */
export function receiveBack(api: ApiClient, orderId: string, body: ReceiveBody, idempotencyKey: string): Promise<TaskOutcome<ReceiveAnswer>> {
  return floorWrite(api, 'POST', `/purchasing/subcontracting/kits/${seg(orderId)}/receive`, { body, schema: receiveAnswer, idempotencyKey })
}

/** GET …/kits/:id/ddts/:ddtId/pdf — a presigned GET of the stored PDF (60 seconds: read it at once). */
export function ddtPdfLink(api: ApiClient, orderId: string, ddtId: string): Promise<TaskOutcome<Presigned>> {
  return floorRead(api, `/purchasing/subcontracting/kits/${seg(orderId)}/ddts/${seg(ddtId)}/pdf`, { schema: z.object({ download: presignedSchema }) }).then((answer) => (answer.ok ? { ok: true, value: answer.value.download } : answer))
}
