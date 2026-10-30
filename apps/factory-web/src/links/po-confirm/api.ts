import { z } from 'zod'
import { ANSWER_OUTCOMES, DECLINE_REASONS, LINE_ANSWERS, type DeclineReason, type LineAnswerKind } from '@nexus/factory-domain/purchasing/confirm/answer'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { presignedSchema, type Presigned } from '../../record-panels/api'
import { putToStore, sha256Hex } from '../../record-panels/store'

/**
 * The supplier's confirm link (apps/factory-api modules/purchasing/confirm; B-W1-31/33; PO_CONFIRM; design links.po,
 * SCR-100): the order as its supplier sees it — WITHOUT any price (Owner answer C2) — what the page may ask, and the
 * answer: confirm all as asked, line by line (the buyer decides on any change: P2), or decline; the supplier's own
 * confirmation PDF goes to the store first (announce → presigned PUT → complete) and its id with the answer. The token
 * travels only in `x-factory-link` (the client the link landing made); every write has an Idempotency-Key.
 */

const instant = z.string()
const day = z.string()

export const linkOrderLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  colour: z.object({ name: z.string().nullable(), supplierCode: z.string().nullable() }).nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  baseQuantity: z.string(),
  baseUom: z.enum(UOMS).nullable(),
  needDate: day,
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  areaTolerancePct: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  requiresCrViTest: z.boolean(),
  note: z.string().nullable(),
  confirmedQuantity: z.string().nullable(),
  confirmedDate: day.nullable(),
  version: z.number(),
})
export type LinkOrderLine = z.infer<typeof linkOrderLineSchema>

const supplierFileSchema = z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED']) })
export type SupplierFile = z.infer<typeof supplierFileSchema>

export const linkOrderSchema = z.object({
  order: z.object({
    id: z.string(),
    number: z.string(),
    documentNumber: z.string(),
    status: z.enum(PURCHASE_ORDER_STATUSES),
    revision: z.number(),
    orderDate: day,
    requestedDate: day.nullable(),
    incoterms: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    note: z.string().nullable(),
    sentAt: instant.nullable(),
    confirmedAt: instant.nullable(),
    confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
    confirmedByName: z.string().nullable(),
    supplierRef: z.string().nullable(),
    confirmNote: z.string().nullable(),
    declinedAt: instant.nullable(),
    declineReason: z.string().nullable(),
    cancelledAt: instant.nullable(),
    version: z.number(),
  }),
  lines: z.array(linkOrderLineSchema),
  from: z.object({ legalName: z.string(), tradeName: z.string().nullable(), buyerName: z.string().nullable() }),
  deliverTo: z.object({ name: z.string(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  canAnswer: z.boolean(),
  message: z.string().nullable(),
  answers: z.array(z.object({ action: z.enum(['confirm', 'decline']), typedName: z.enum(['required', 'optional', 'none']), email: z.boolean() })),
  lineAnswers: z.array(z.enum(LINE_ANSWERS)),
  declineReasons: z.array(z.enum(DECLINE_REASONS)),
  document: z.string(),
  expiresAt: instant,
})
export type LinkOrder = z.infer<typeof linkOrderSchema>

export const answerEndSchema = linkOrderSchema.extend({
  outcome: z.enum(ANSWER_OUTCOMES),
  summary: z.string().nullable(),
  done: z.string(),
  confirmationFile: supplierFileSchema.nullable().optional(),
})
export type AnswerEnd = z.infer<typeof answerEndSchema>

export function readLinkOrder(api: ApiClient, signal?: AbortSignal): Promise<LinkOrder> {
  return api.get('/link/purchase-order', { schema: linkOrderSchema, signal })
}

export interface LineAnswerBody {
  readonly lineId: string
  readonly answer: LineAnswerKind
  readonly quantity?: string | null
  readonly date?: string | null
  readonly deliveries?: { quantity: string; date: string }[] | null
  readonly reason?: string | null
}

export interface ConfirmBody {
  readonly version: number
  readonly mode: 'ALL_AS_ASKED' | 'BY_LINE'
  readonly lines?: LineAnswerBody[] | null
  readonly supplierRef?: string | null
  readonly note?: string | null
  readonly typedName?: string | null
  readonly confirmationFileId?: string | null
}

export function confirmLinkOrder(api: ApiClient, body: ConfirmBody, idempotencyKey: string = newIdempotencyKey()): Promise<AnswerEnd> {
  return api.post('/link/purchase-order/confirm', { body, schema: answerEndSchema, idempotencyKey })
}

export function declineLinkOrder(api: ApiClient, body: { version: number; reason: DeclineReason; note?: string | null; typedName?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<AnswerEnd> {
  return api.post('/link/purchase-order/decline', { body, schema: answerEndSchema, idempotencyKey })
}

/** A dead link is not a dead end: one answer whatever the token was (the sender writes to the address on file). */
export function askNewOrderLink(api: ApiClient): Promise<{ status: 'requested'; message: string }> {
  return api.post('/link/purchase-order/renew', { body: {}, schema: z.object({ status: z.literal('requested'), message: z.string() }), idempotencyKey: newIdempotencyKey() })
}

/** A file the supplier chose (its bytes hashed and sent to the store). */
export interface PickedPdf {
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly bytes: ArrayBuffer
}

export async function pickedPdf(file: File): Promise<PickedPdf> {
  return { name: file.name, contentType: file.type || 'application/pdf', size: file.size, bytes: await file.arrayBuffer() }
}

const announcedSchema = z.object({ file: supplierFileSchema, upload: presignedSchema })

/**
 * The supplier's confirmation PDF: announced on the link (`POST /link/purchase-order/confirmation`), its bytes sent
 * straight to the store with the presigned PUT, then confirmed (`…/confirmation/<id>/complete`): AVAILABLE, or
 * QUARANTINED when what arrived differs from what was announced.
 */
export async function uploadConfirmation(api: ApiClient, file: PickedPdf, put: (presigned: Presigned, bytes: ArrayBuffer) => Promise<void> = putToStore): Promise<SupplierFile> {
  const sha256 = await sha256Hex(file.bytes)
  const announced = await api.post('/link/purchase-order/confirmation', {
    body: { originalName: file.name, contentType: file.contentType, sizeBytes: file.size, sha256 },
    schema: announcedSchema,
    idempotencyKey: newIdempotencyKey(),
  })
  await put(announced.upload as Presigned, file.bytes)
  const completed = await api.post(`/link/purchase-order/confirmation/${encodeURIComponent(announced.file.id)}/complete`, {
    body: {},
    schema: z.object({ file: supplierFileSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
  return completed.file
}
