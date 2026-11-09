import { z } from 'zod'
import { DECLINE_REASONS, JOB_CHIPS, JOB_STATES, NEXT_STEPS, type DeclineReason, type JobChip } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * A workshop's jobs in the portal (apps/factory-api modules/purchasing/portal-jobs, B-W2b-176; design portal.supplier.jobs,
 * SCR-192 / SCR-193): the list with its chips and counts, one job (operations with pieces per size and finished per size,
 * the bundles that went out, the kit we sent and the workshop's check, the reports, the send-backs), and the acts: accept
 * (as asked or with another due-back day), decline, the kit check (all as listed or per line, a photo of damage), finished
 * pieces, a send-back. NOTHING here is money (Owner answer C2): no schema holds a fee, price, cost or amount.
 *
 * The API's sentences (`stateWords`, `nextStepWords`, the chips' `words`, `acts.*`, `choices.*.words`, the stored decline
 * text, the end's `done`) are left out or read only as "held or not": the page says everything from codes and figures in
 * its own words (`portal-jobs`). Every write carries an Idempotency-Key and the job's version.
 */

export { DECLINE_REASONS, JOB_CHIPS, JOB_STATES, NEXT_STEPS }
export type { DeclineReason, JobChip }
export type JobState = (typeof JOB_STATES)[number]
export type NextStep = (typeof NEXT_STEPS)[number]

export const isJobChip = (value: unknown): value is JobChip => typeof value === 'string' && (JOB_CHIPS as readonly string[]).includes(value)

const live = z.object({ events: z.array(z.string()) })
const item = z.object({ code: z.string(), name: z.string() })
const cell = { workOrderSizeId: z.string().nullable(), colourway: z.string(), size: z.string() }
const ref = z.object({ id: z.string(), code: z.string() })
const ddt = z.object({ number: z.string(), date: z.string().nullable() })
/** An act the API holds says so in its own words: the page keeps only whether it is held. */
const held = z
  .string()
  .nullable()
  .transform((value) => value !== null)

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const jobRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  state: z.enum(JOB_STATES),
  chip: z.enum(JOB_CHIPS),
  nextStep: z.enum(NEXT_STEPS),
  operations: z.array(z.object({ seq: z.number(), code: z.string(), name: z.string() })),
  workOrder: z.object({ number: z.string(), style: item }),
  pieces: z.number(),
  finished: z.number(),
  kitDate: z.string().nullable(),
  dueBack: z.string().nullable(),
  late: z.boolean(),
  proposedDate: z.string().nullable(),
  version: z.number(),
})
export type JobRow = z.infer<typeof jobRowSchema>

export const jobsSchema = z.object({
  asOf: z.string(),
  chip: z.enum(JOB_CHIPS),
  chips: z.array(z.object({ chip: z.enum(JOB_CHIPS), count: z.number() })),
  counts: z.object({ toAccept: z.number(), kitToConfirm: z.number(), readyToSendBack: z.number(), late: z.number() }),
  items: z.array(jobRowSchema),
  complete: z.boolean(),
  live,
})
export type JobsRead = z.infer<typeof jobsSchema>

export const fetchJobs = (api: ApiClient, query: { chip?: JobChip | null; q?: string | null }, signal?: AbortSignal): Promise<JobsRead> =>
  api.get('/portal/jobs', { query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined }, schema: jobsSchema, signal })

// ── one job ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const operationSchema = z.object({
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
  note: z.string().nullable(),
})
export type JobOperation = z.infer<typeof operationSchema>

export const kitLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  item,
  colour: z.string().nullable(),
  lot: z.string().nullable(),
  hide: z.string().nullable(),
  quantity: z.string(),
  uom: z.string(),
  status: z.string(),
  sentAt: z.string().nullable(),
  ddt: ddt.nullable(),
  check: z.object({ at: z.string(), quantity: z.string(), note: z.string().nullable(), short: z.boolean() }).nullable(),
  photos: z.array(z.object({ id: z.string(), originalName: z.string(), createdAt: z.string() })),
})
export type KitLine = z.infer<typeof kitLineSchema>

export const RETURN_STATES = ['ANNOUNCED', 'RECEIVED', 'CANCELLED'] as const

export const jobSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  state: z.enum(JOB_STATES),
  chip: z.enum(JOB_CHIPS),
  nextStep: z.enum(NEXT_STEPS),
  from: z.object({ companyName: z.string() }),
  workOrder: z.object({ number: z.string(), style: item }),
  orderDate: z.string(),
  expectedBackDate: z.string().nullable(),
  issuedAt: z.string().nullable(),
  note: z.string().nullable(),
  answer: z.object({
    acceptedAt: z.string().nullable(),
    acceptedByName: z.string().nullable(),
    proposedDate: z.string().nullable(),
    proposedDateReason: z.string().nullable(),
    declinedAt: z.string().nullable(),
    declinedByName: z.string().nullable(),
    dateDecision: z.object({ decision: z.enum(['ACCEPTED', 'REFUSED']), at: z.string() }).nullable(),
  }),
  operations: z.array(operationSchema),
  bundles: z.array(z.object({ id: z.string(), code: z.string(), ...cell, quantity: z.number(), sentAt: z.string() })),
  kit: z.object({ sentOn: z.array(z.string()), toConfirm: z.number(), lines: z.array(kitLineSchema) }),
  finishBy: z.string().nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      operationId: z.string(),
      operationSeq: z.number(),
      ...cell,
      bundle: ref.nullable(),
      finished: z.number(),
      finishBy: z.string().nullable(),
      byName: z.string(),
      byOffice: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
  returns: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      status: z.enum(RETURN_STATES),
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
  acts: z.object({ accept: held, decline: held, kit: held, progress: held, sendBack: held }),
  choices: z.object({ declineReasons: z.array(z.object({ code: z.enum(DECLINE_REASONS) })), scrapReasons: z.array(z.object({ code: z.string() })) }),
  version: z.number(),
})
export type Job = z.infer<typeof jobSchema>
export type JobReport = Job['reports'][number]
export type JobReturn = Job['returns'][number]
export type JobBundle = Job['bundles'][number]

export const jobPageSchema = z.object({ job: jobSchema, mayAct: z.object({ approve: z.boolean(), comment: z.boolean(), upload: z.boolean() }), live })
export type JobPage = z.infer<typeof jobPageSchema>

const seg = (id: string) => encodeURIComponent(id)

export const fetchJob = (api: ApiClient, id: string, signal?: AbortSignal): Promise<JobPage> => api.get(`/portal/jobs/${seg(id)}`, { schema: jobPageSchema, signal })

// ── the acts ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AcceptBody {
  proposedDate?: string
  reason?: string
}
export interface DeclineBody {
  reason: DeclineReason
  note?: string
}
export interface KitBody {
  all?: boolean
  lines?: { kitLineId: string; quantity: string; note?: string }[]
}
export interface ProgressBody {
  entries: { operationId: string; workOrderSizeId?: string; bundleId?: string; finished: number }[]
  finishBy?: string
  note?: string
}
export interface ReturnBody {
  quantities: { operationId: string; workOrderSizeId?: string; bundleId?: string; finished: number; scrapped?: number; reasonCode?: string }[]
  materialBack?: { kitLineId: string; quantity: string }[]
  parcels: number
  expectedDate: string
  weCollect?: boolean
  ddt?: { number: string; date?: string }
  note?: string
}

export type JobAct = { act: 'accept'; body: AcceptBody } | { act: 'decline'; body: DeclineBody } | { act: 'kit'; body: KitBody } | { act: 'progress'; body: ProgressBody } | { act: 'returns'; body: ReturnBody }

/** One act at the version the page showed; the answer is the job again (its `done` sentence is not read: the page words the end). */
export function sendJobAct(api: ApiClient, id: string, version: number, act: JobAct, idempotencyKey: string): Promise<JobPage> {
  return api.post(`/portal/jobs/${seg(id)}/${act.act}`, { body: { version, ...act.body }, schema: jobPageSchema, idempotencyKey })
}

const announced = z.object({ file: z.object({ id: z.string(), originalName: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string(), originalName: z.string() }) })

/** A photo of a missing or damaged kit item: announce → the bytes to the store → complete (PHOTO, shared with us). */
export async function uploadKitPhoto(api: ApiClient, jobId: string, kitLineId: string, file: Blob, name: string): Promise<{ id: string; originalName: string }> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'image/jpeg'
  const first = await api.post(`/portal/jobs/${seg(jobId)}/kit/photos`, {
    body: { kitLineId, originalName: name, contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: announced,
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(first.upload, bytes)
  const done = await api.post(`/portal/jobs/${seg(jobId)}/kit/photos/${seg(first.file.id)}/complete`, { schema: completed, idempotencyKey: newIdempotencyKey() })
  return done.file
}
