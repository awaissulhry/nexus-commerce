import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * What the workshop said on a subcontract order, and the office's acts on it (B-W2b-176; apps/factory-api
 * modules/purchasing/portal-jobs: contract.ts `workshopAnswer`): GET …/orders/:id/workshop, the job link (mailed, or its
 * address handed out once), the answer to a proposed date, the workshop's acts written by the office for a workshop
 * without e-mail (Owner answer C3), the cancel of an announced send-back. Every write takes the job's version and an
 * Idempotency-Key and answers the same view. The shapes are checked (zod; unknown fields dropped). The API's English
 * held sentences (`acts`, `office.decideDate`, `office.sendLink`) are read only to know WHETHER an act is held: the
 * screen says WHY in its own words (./model.ts). Nothing here is money (Owner answer C2).
 */

const enc = encodeURIComponent
const cell = { workOrderSizeId: z.string().nullable(), colourway: z.string(), size: z.string() }
const item = z.object({ code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string() })
const ddt = z.object({ number: z.string(), date: z.string().nullable() })

export const JOB_STATES = ['TO_ANSWER', 'DECLINED', 'WAITING_KIT', 'IN_WORK', 'PARTLY_BACK', 'BACK', 'CLOSED', 'CANCELLED'] as const
export type JobState = (typeof JOB_STATES)[number]
export const DECLINE_REASONS = ['NO_CAPACITY', 'DATES', 'OTHER'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]
export const RETURN_STATUSES = ['ANNOUNCED', 'RECEIVED', 'CANCELLED'] as const

const jobSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  state: z.enum(JOB_STATES),
  chip: z.string(),
  nextStep: z.string(),
  orderDate: z.string(),
  expectedBackDate: z.string().nullable(),
  note: z.string().nullable(),
  answer: z.object({
    acceptedAt: z.string().nullable(),
    acceptedByName: z.string().nullable(),
    proposedDate: z.string().nullable(),
    proposedDateReason: z.string().nullable(),
    declinedAt: z.string().nullable(),
    declinedByName: z.string().nullable(),
    declineReason: z.string().nullable(),
    dateDecision: z.object({ decision: z.enum(['ACCEPTED', 'REFUSED']), at: z.string() }).nullable(),
  }),
  operations: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      code: z.string(),
      name: z.string(),
      pieces: z.number(),
      sizes: z.array(z.object({ ...cell, workOrderSizeId: z.string(), pieces: z.number(), finished: z.number() })),
      expectedBackDate: z.string().nullable(),
      piecesSent: z.number(),
      back: z.object({ good: z.number(), defective: z.number(), scrapped: z.number() }),
      finished: z.number(),
      announced: z.number(),
      ready: z.number(),
      announceable: z.number(),
    }),
  ),
  bundles: z.array(z.object({ id: z.string(), code: z.string(), ...cell, quantity: z.number(), sentAt: z.string() })),
  kit: z.object({
    sentOn: z.array(z.string()),
    toConfirm: z.number(),
    lines: z.array(
      z.object({
        id: z.string(),
        seq: z.number(),
        item,
        colour: z.string().nullable(),
        lot: z.string().nullable(),
        hide: z.string().nullable(),
        quantity: z.string(),
        uom: z.string(),
        status: z.enum(['PLANNED', 'SENT', 'CANCELLED']),
        sentAt: z.string().nullable(),
        ddt: ddt.nullable(),
        check: z.object({ at: z.string(), quantity: z.string(), note: z.string().nullable(), short: z.boolean() }).nullable(),
        photos: z.array(z.object({ id: z.string(), originalName: z.string(), createdAt: z.string() })),
      }),
    ),
  }),
  finishBy: z.string().nullable(),
  reports: z.array(
    z.object({ id: z.string(), at: z.string(), operationId: z.string(), operationSeq: z.number(), ...cell, bundle: ref.nullable(), finished: z.number(), finishBy: z.string().nullable(), byName: z.string(), byOffice: z.boolean(), note: z.string().nullable() }),
  ),
  returns: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      status: z.enum(RETURN_STATUSES),
      expectedDate: z.string(),
      parcels: z.number(),
      weCollect: z.boolean(),
      ddt: ddt.nullable(),
      pieces: z.number(),
      quantities: z.array(z.object({ operationId: z.string(), operationSeq: z.number(), ...cell, bundle: ref.nullable(), finished: z.number(), scrapped: z.number(), reasonCode: z.string().nullable() })),
      materialBack: z.array(z.object({ kitLineId: z.string(), seq: z.number(), item, quantity: z.string(), uom: z.string().nullable() })),
      byName: z.string(),
      byOffice: z.boolean(),
      note: z.string().nullable(),
      announcedAt: z.string(),
      receivedAt: z.string().nullable(),
      cancelledAt: z.string().nullable(),
      cancelReason: z.string().nullable(),
    }),
  ),
  /** Whether each act is held (the API's English reason: read for WHETHER, never shown). */
  acts: z.object({ accept: z.string().nullable(), decline: z.string().nullable(), kit: z.string().nullable(), progress: z.string().nullable(), sendBack: z.string().nullable() }),
  choices: z.object({ scrapReasons: z.array(z.object({ code: z.string(), words: z.string() })) }),
  version: z.number(),
})
export type WorkshopJob = z.infer<typeof jobSchema>
export type JobKitLine = WorkshopJob['kit']['lines'][number]
export type JobOperation = WorkshopJob['operations'][number]
export type JobReturn = WorkshopJob['returns'][number]

const prefillSchema = z.object({
  returnNoticeId: z.string(),
  lines: z.array(z.object({ operationId: z.string(), bundleId: z.string().nullable(), good: z.number(), defective: z.number(), scrapped: z.number(), reason: z.string().nullable() })),
  supplierDdt: ddt.nullable(),
  returns: z.array(z.object({ kitLineId: z.string(), itemId: z.string(), itemColourId: z.string().nullable(), lotId: z.string().nullable(), hideId: z.string().nullable(), quantity: z.string(), uom: z.string() })),
  note: z.string().nullable(),
})
export type ReceivePrefill = z.infer<typeof prefillSchema>

export const workshopSchema = z.object({
  job: jobSchema,
  links: z.array(z.object({ id: z.string(), email: z.string().nullable(), state: z.string(), expiresAt: z.string(), usedAt: z.string().nullable(), createdAt: z.string() })),
  prefills: z.array(prefillSchema),
  reach: z.object({ contacts: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), language: z.string().nullable() })), portalOn: z.boolean(), portalPeople: z.number() }),
  office: z.object({ manage: z.boolean(), receive: z.boolean(), decideDate: z.string().nullable(), sendLink: z.string().nullable() }),
})
export type WorkshopAnswer = z.infer<typeof workshopSchema>

const linkAnswerSchema = workshopSchema.extend({ url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() })
export type JobLinkAnswer = z.infer<typeof linkAnswerSchema>

const base = (id: string) => `/purchasing/subcontracting/orders/${enc(id)}`

export function getWorkshop(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<WorkshopAnswer> {
  return api.get(`${base(orderId)}/workshop`, { schema: workshopSchema, ...(signal ? { signal } : {}) })
}

export interface JobLinkBody {
  contactId?: string
  email?: string
  send: boolean
  language?: 'it' | 'en'
}

export function sendJobLink(api: ApiClient, orderId: string, body: JobLinkBody, idempotencyKey: string): Promise<JobLinkAnswer> {
  return api.post(`${base(orderId)}/job-link`, { body, schema: linkAnswerSchema, idempotencyKey })
}

export function decideDate(api: ApiClient, orderId: string, version: number, decision: 'ACCEPTED' | 'REFUSED', idempotencyKey: string): Promise<WorkshopAnswer> {
  return api.post(`${base(orderId)}/workshop/date`, { body: { version, decision }, schema: workshopSchema, idempotencyKey })
}

export interface AcceptBody {
  proposedDate?: string
  reason?: string
  name?: string
}
export interface DeclineBody {
  reason: DeclineReason
  note?: string
  name?: string
}
export interface KitBody {
  all?: boolean
  lines?: { kitLineId: string; quantity: string; note?: string }[]
}
export interface ProgressBody {
  entries: { operationId: string; workOrderSizeId?: string; bundleId?: string; finished: number }[]
  finishBy?: string
  note?: string
  name?: string
}
export interface ReturnBody {
  quantities: { operationId: string; bundleId?: string; workOrderSizeId?: string; finished: number; scrapped?: number; reasonCode?: string }[]
  materialBack?: { kitLineId: string; quantity: string }[]
  parcels: number
  expectedDate: string
  weCollect?: boolean
  ddt?: { number: string; date?: string } | null
  note?: string
  name?: string
}

/** The workshop's acts the office writes for it (C3). */
export type ForWorkshop = { act: 'accept'; body: AcceptBody } | { act: 'decline'; body: DeclineBody } | { act: 'kit'; body: KitBody } | { act: 'progress'; body: ProgressBody } | { act: 'returns'; body: ReturnBody }

export function actForWorkshop(api: ApiClient, orderId: string, version: number, act: ForWorkshop, idempotencyKey: string): Promise<WorkshopAnswer> {
  return api.post(`${base(orderId)}/workshop/${act.act}`, { body: { version, ...act.body }, schema: workshopSchema, idempotencyKey })
}

export function cancelReturn(api: ApiClient, orderId: string, returnNoticeId: string, version: number, reason: string, idempotencyKey: string): Promise<WorkshopAnswer> {
  return api.post(`${base(orderId)}/workshop/returns/${enc(returnNoticeId)}/cancel`, { body: { version, reason }, schema: workshopSchema, idempotencyKey })
}
