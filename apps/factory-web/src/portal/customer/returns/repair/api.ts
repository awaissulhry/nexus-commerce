import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Repairs in the customer's portal (apps/factory-api modules/sales/repairs-depth/portal.ts, B-W2b-342; SAL-384, SAL-385,
 * SAL-387; follow-up RR1:02), each answer checked against the API's contracts:
 *
 *   GET  /portal/repairs                                the party's repairs, newest first
 *   POST /portal/repairs                                a repair or alteration request (a repair waiting for the garment)
 *   GET  /portal/repairs/:id                            one repair: what was asked, where it is, the photos, the estimate
 *   POST /portal/repairs/:id/photos (+ /:fileId/complete)  a damage photo, PUT to the store between
 *   POST /portal/repairs/files/:fileId/open             one of the customer's photos (logged)
 *   POST /portal/repairs/:id/estimate/answer            accept or decline the sent estimate
 *
 * The estimate's prices come only with the person's price grain (the API drops them otherwise): every price field is
 * optional here. Every write carries an Idempotency-Key.
 */

export const REPAIR_KINDS = ['REPAIR', 'ALTERATION'] as const
export type RepairKind = (typeof REPAIR_KINDS)[number]
export const STEP_CODES = ['RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED'] as const

const ref = z.object({ code: z.string(), name: z.string() })
const garment = z.object({ style: ref.nullable(), colourway: ref.nullable(), size: z.string().nullable(), serial: z.string().nullable() })
const next = z.object({ code: z.string(), forYou: z.boolean() })

export const repairItemSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(REPAIR_KINDS),
  stage: z.string(),
  channel: z.string(),
  opened: z.string(),
  open: z.boolean(),
  next,
  garment,
  estimate: z.object({ revision: z.number(), status: z.string() }).nullable(),
})
export type RepairItem = z.infer<typeof repairItemSchema>

export const repairsSchema = z.object({ items: z.array(repairItemSchema), mayRequest: z.boolean(), seesPrices: z.boolean(), asOf: z.string() })
export type RepairsRead = z.infer<typeof repairsSchema>

const money = z.number().optional()
const estimateSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.string(),
  currency: z.string(),
  validUntil: z.string().nullable(),
  customerNote: z.string().nullable(),
  sentAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredVia: z.string().nullable(),
  declineReason: z.string().nullable(),
  version: z.number(),
  lines: z.array(z.object({ seq: z.number(), kind: z.enum(['PART', 'LABOUR']), description: z.string(), quantity: z.string(), minutes: z.number().nullable(), unitPrice: z.string().optional(), amount: money })),
  amount: money,
  partsAmount: money,
  labourAmount: money,
  labourMinutes: z.number(),
})
export type RepairEstimate = z.infer<typeof estimateSchema>

export const repairSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(REPAIR_KINDS),
  stage: z.string(),
  channel: z.string(),
  opened: z.string(),
  version: z.number(),
  open: z.boolean(),
  problem: z.string(),
  workWanted: z.string().nullable(),
  garment,
  steps: z.array(z.object({ stage: z.enum(STEP_CODES), state: z.enum(['DONE', 'CURRENT', 'WAITING', 'SKIPPED']), at: z.string().nullable() })),
  next,
  receivedAt: z.string().nullable(),
  repairedAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  sendTo: z.object({ name: z.string(), address: z.string().nullable() }).nullable(),
  photos: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string(), at: z.string() })),
  estimate: estimateSchema.nullable(),
  actions: z.object({ addPhotos: z.string().nullable(), answer: z.string().nullable() }),
})
export type Repair = z.infer<typeof repairSchema>

const recordSchema = z.object({ repair: repairSchema, mayRequest: z.boolean(), mayUpload: z.boolean(), seesPrices: z.boolean() })
export type RepairRecord = z.infer<typeof recordSchema>
const sentSchema = z.object({ type: z.literal('REPAIR'), id: z.string(), number: z.string(), answerBy: z.string().nullable() })

export interface RepairRequestBody {
  kind: RepairKind
  salesOrderLineId: string | null
  size: string | null
  serial: string | null
  problem: string | null
  workWanted: string | null
}

export const fetchRepairs = (api: ApiClient, signal?: AbortSignal): Promise<RepairsRead> => api.get('/portal/repairs', { schema: repairsSchema, signal })

export const fetchRepair = (api: ApiClient, id: string, signal?: AbortSignal): Promise<RepairRecord> => api.get(`/portal/repairs/${encodeURIComponent(id)}`, { schema: recordSchema, signal })

export const requestRepair = (api: ApiClient, body: RepairRequestBody, idempotencyKey: string): Promise<{ id: string; sent: z.infer<typeof sentSchema> }> =>
  api.post('/portal/repairs', { body, schema: recordSchema.extend({ sent: sentSchema }), idempotencyKey }).then((read) => ({ id: read.repair.id, sent: read.sent }))

const presigned = z.object({ method: z.enum(['GET', 'PUT']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const uploadSchema = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }), upload: presigned })
const doneSchema = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }) })

export interface RepairPhotoBody {
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}

export const announceRepairPhoto = (api: ApiClient, id: string, body: RepairPhotoBody, idempotencyKey: string) => api.post(`/portal/repairs/${encodeURIComponent(id)}/photos`, { body, schema: uploadSchema, idempotencyKey })

export const completeRepairPhoto = (api: ApiClient, id: string, fileId: string, idempotencyKey: string) =>
  api.post(`/portal/repairs/${encodeURIComponent(id)}/photos/${encodeURIComponent(fileId)}/complete`, { schema: doneSchema, idempotencyKey })

const openSchema = z.object({ file: z.object({ id: z.string(), name: z.string(), contentType: z.string() }), download: presigned.extend({ mode: z.enum(['inline', 'download']) }) })

/** One of the customer's photos of their repair (ONE logged open; a 60-second address; a picture without location). */
export const openRepairPhoto = (api: ApiClient, fileId: string) => api.post(`/portal/repairs/files/${encodeURIComponent(fileId)}/open`, { body: { mode: 'preview' }, schema: openSchema, idempotencyKey: newIdempotencyKey() })

export interface AnswerBody {
  estimateId: string
  version: number
  answer: 'ACCEPTED' | 'DECLINED'
  declineReason?: string | null
}

export const answerEstimate = (api: ApiClient, id: string, body: AnswerBody, idempotencyKey: string): Promise<RepairRecord> =>
  api.post(`/portal/repairs/${encodeURIComponent(id)}/estimate/answer`, { body, schema: recordSchema, idempotencyKey })
