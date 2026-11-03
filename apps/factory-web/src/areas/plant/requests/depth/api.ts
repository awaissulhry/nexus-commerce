import { z } from 'zod'
import { HAND_BACK_ACTION_CODES, type HandBackAction } from '@nexus/factory-domain/plant/jobs/close'
import { PROGRESS_STEPS, TRAIL_KINDS } from '@nexus/factory-domain/plant/requests/progress'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { jobSchema, machineSchema, MACHINE_AFTER, requestSchema, type MachineAfter, type MachineCard, type RequestStatus, type RequestTile } from '../../_shared/api'

/**
 * The calls of Machine requests and Maintenance jobs in depth (B-W2b-140 on the API of B-W2b-96; QHS-179 … QHS-190):
 * the open locks (the queue's first banner), the possible duplicates and their merge into one, Lock as unsafe, the
 * requester's progress (on the way, it works), photos and voice notes of a request or a job, the one-screen close with
 * its tiles, and the line lead's confirmation. W2a's schemas (`_shared/api.ts`) drop the fields they do not know, so the
 * depth reads extend them here; every write is one command with its own Idempotency-Key and the version read. The API's
 * English (`words`) is never drawn: the screens say their own words from codes and figures.
 */

const person = z.object({ kind: z.enum(['USER', 'WORKER', 'STATION']), id: z.string().nullable(), name: z.string().nullable() })

/** What the reporter sees (QHS-180): acknowledged, on the way, fixed (the job handed back), works again. */
const progressSchema = z.object({
  step: z.enum(PROGRESS_STEPS),
  acknowledgedAt: z.string().nullable(),
  onTheWayAt: z.string().nullable(),
  onTheWayBy: person.nullable(),
  fixedAt: z.string().nullable(),
  worksAt: z.string().nullable(),
  worksBy: person.nullable(),
  closedWithoutJob: z.boolean(),
  canConfirm: z.boolean(),
})
export type RequestProgress = z.infer<typeof progressSchema>

/** Where it was sent and how far it escalated (QHS-179): a team, or a technician (by name inside one record). */
const routingSchema = z.object({
  routedTo: z.object({ kind: z.enum(['TEAM', 'TECHNICIAN']), id: z.string().nullable(), name: z.string().nullable() }).nullable(),
  ruleId: z.string().nullable(),
  escalationLevel: z.number(),
  escalatedAt: z.string().nullable(),
})
export type RequestRouting = z.infer<typeof routingSchema>

export const deepRequestSchema = requestSchema.extend({ voiceNotes: z.number(), progress: progressSchema, routing: routingSchema })
export type DeepRequest = z.infer<typeof deepRequestSchema>

/** A photo or voice note of a request or a job (a job's photo: before or after the work). */
export const mediaSchema = z.object({
  id: z.string(),
  kind: z.enum(['PHOTO', 'AUDIO']),
  category: z.enum(['BEFORE_WORK', 'AFTER_WORK']).nullable(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  availableAt: z.string().nullable(),
})
export type Media = z.infer<typeof mediaSchema>
export type MediaCategory = NonNullable<Media['category']>

export const TRAIL = TRAIL_KINDS
const trailSchema = z.object({ kind: z.enum(TRAIL_KINDS), at: z.string(), level: z.number().nullable() })
export type TrailEntry = z.infer<typeof trailSchema>

const jobRef = z.object({ id: z.string(), number: z.string(), status: z.string() })
const cardSchema = z.object({
  machine: machineSchema,
  openJob: z.object({ id: z.string(), number: z.string(), status: jobSchema.shape.status }).nullable(),
  lastJobs: z.array(z.object({ id: z.string(), number: z.string(), type: jobSchema.shape.type, status: jobSchema.shape.status, problem: z.string(), createdAt: z.string(), closedAt: z.string().nullable() })),
  requestsIn30Days: z.number(),
  repeatFailure: z.boolean(),
}) satisfies z.ZodType<MachineCard>

const requestRecordSchema = z.object({
  request: deepRequestSchema,
  card: cardSchema,
  duplicates: z.array(deepRequestSchema),
  files: z.array(mediaSchema),
  trail: z.array(trailSchema),
  canGo: z.boolean(),
  canConfirm: z.boolean(),
  canLock: z.boolean(),
  canTriage: z.boolean(),
  canSignSafe: z.boolean(),
})
export type DeepRequestRecord = z.infer<typeof requestRecordSchema>

const lockSchema = z.object({ machine: machineSchema, request: deepRequestSchema, canSignSafe: z.boolean() })
export type MachineLock = z.infer<typeof lockSchema>

const groupSchema = z.object({
  machine: deepRequestSchema.shape.machine,
  /** Oldest first. */
  requests: z.array(deepRequestSchema),
  withinMinutes: z.number(),
  /** The machine's open job, else the request that locks the machine, else the oldest. */
  suggested: z.object({ kind: z.enum(['JOB', 'REQUEST']), job: jobRef.nullable(), requestId: z.string().nullable() }),
})
export type DuplicateGroup = z.infer<typeof groupSchema>

/** The hand-back with its failure code and the API's minutes from the start; the line lead's confirmation. */
export const deepJobSchema = jobSchema.extend({
  handedBack: z.object({ at: z.string(), by: person, workDone: z.string(), machineAfter: z.enum(MACHINE_AFTER), failureCode: z.string().nullable(), minutesSpent: z.number().nullable() }).nullable(),
  leadConfirmed: z.object({ at: z.string(), by: person }).nullable(),
})
export type DeepJob = z.infer<typeof deepJobSchema>

const jobRecordSchema = z.object({
  job: deepJobSchema,
  card: cardSchema,
  requests: z.array(deepRequestSchema),
  canManage: z.boolean(),
  canWork: z.boolean(),
  /** The machine's lock (its first unsafe request not yet signed safe); null: not locked. Its `reason` (the machine's status words, English) is not read. */
  lock: z.object({ request: deepRequestSchema, since: z.string(), canSignSafe: z.boolean() }).nullable(),
  files: z.array(mediaSchema),
  requestFiles: z.array(mediaSchema.extend({ requestId: z.string() })),
  close: z.object({ minutesSoFar: z.number().nullable(), runningHeld: z.boolean(), canHandBack: z.boolean() }),
  canConfirm: z.boolean(),
})
export type DeepJobRecord = z.infer<typeof jobRecordSchema>
export type JobClose = DeepJobRecord['close']

// ---- reads ----------------------------------------------------------------------------------------------------------------------

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

export interface DeepRequestsQuery {
  siteId?: string | null
  status?: readonly RequestStatus[] | null
  open?: boolean
  tile?: RequestTile | null
  cursor?: string | null
  limit?: number
}

/** GET /plant/requests with the depth fields (routing, escalation, voice notes, progress). */
export const listDeepRequests = (api: ApiClient, query: DeepRequestsQuery, signal?: AbortSignal) =>
  api.get('/plant/requests', {
    query: clean({ siteId: query.siteId, status: query.status?.length ? query.status.join(',') : undefined, open: query.open ? 'true' : undefined, tile: query.tile, cursor: query.cursor, limit: query.limit }),
    schema: z.object({ requests: z.array(deepRequestSchema), nextCursor: z.string().nullable(), truncated: z.boolean() }),
    signal,
  })

/** GET /plant/requests/:id with its files, its routing and progress trail, and what this person may do now. */
export const getDeepRequest = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/requests/${seg(id)}`, { schema: requestRecordSchema, signal })

/** GET /plant/requests/locks: every machine locked as unsafe now, its first lock (always first on the page). */
export const readLocks = (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  api.get('/plant/requests/locks', { query: clean({ siteId }), schema: z.object({ locks: z.array(lockSchema) }), signal }).then((answer) => answer.locks)

/** GET /plant/requests/duplicates: machines with two or more open requests, each with the suggested target. */
export const readDuplicates = (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  api.get('/plant/requests/duplicates', { query: clean({ siteId }), schema: z.object({ groups: z.array(groupSchema) }), signal }).then((answer) => answer.groups)

export const getDeepJob = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/jobs/${seg(id)}`, { schema: jobRecordSchema, signal })

// ---- writes ---------------------------------------------------------------------------------------------------------------------

export interface MergeBody {
  requests: { id: string; version: number }[]
  /** Into this request (each becomes MERGED) — or into the machine's open job (each joins it). */
  intoId?: string
  intoJobId?: string
}

/** POST /plant/requests/merge: all or none; every reporter keeps their request and follows the target. */
export const mergeRequests = (api: ApiClient, body: MergeBody) =>
  api.post('/plant/requests/merge', { body, schema: z.object({ requests: z.array(deepRequestSchema), target: deepRequestSchema.nullable(), job: jobSchema.nullable(), replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })

const lockAnswer = z.object({ lock: deepRequestSchema, from: deepRequestSchema, joined: z.boolean(), machine: machineSchema, replayed: z.boolean() })
export type LockAnswer = z.infer<typeof lockAnswer>

/** POST /plant/requests/:id/lock: a NEW unsafe request of the office user (the machine do-not-use at once); the request joins it. */
export const lockAsUnsafe = (api: ApiClient, id: string, body: { version: number; note?: string }, idempotencyKey: string) => api.post(`/plant/requests/${seg(id)}/lock`, { body, schema: lockAnswer, idempotencyKey })

const stepAnswer = z.object({ request: deepRequestSchema, machine: machineSchema, replayed: z.boolean() })

/** POST /plant/requests/:id/on-the-way (a technician; from NEW it acknowledges too). */
export const sayOnTheWay = (api: ApiClient, id: string, version: number) => api.post(`/plant/requests/${seg(id)}/on-the-way`, { body: { version }, schema: stepAnswer, idempotencyKey: newIdempotencyKey() })

/** POST /plant/requests/:id/works (the office user who reported it confirms the machine works again). */
export const confirmWorks = (api: ApiClient, id: string, version: number) => api.post(`/plant/requests/${seg(id)}/works`, { body: { version }, schema: stepAnswer, idempotencyKey: newIdempotencyKey() })

export interface HandBackBody {
  version: number
  machineAfter: MachineAfter
  action?: HandBackAction
  failureCode?: string | null
  workDone?: string
}
export { HAND_BACK_ACTION_CODES }

const moveAnswer = z.object({ job: deepJobSchema, machine: machineSchema, replayed: z.boolean() })

/** POST /plant/jobs/:id/hand-back: the one-screen close (the action tile, the failure code tile, words, the machine after). */
export const handBackJob = (api: ApiClient, id: string, body: HandBackBody) => api.post(`/plant/jobs/${seg(id)}/hand-back`, { body, schema: moveAnswer, idempotencyKey: newIdempotencyKey() })

/** POST /plant/jobs/:id/confirm: the line lead confirms the machine works (once, while handed back). */
export const confirmJobWorks = (api: ApiClient, id: string, version: number) => api.post(`/plant/jobs/${seg(id)}/confirm`, { body: { version }, schema: moveAnswer, idempotencyKey: newIdempotencyKey() })

// ---- photos and voice notes -------------------------------------------------------------------------------------------------------

export type MediaOwner = { type: 'request'; id: string } | { type: 'job'; id: string; category: MediaCategory | null }

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string() }) })

/**
 * A photo or voice note to a request or a job (the plant routes: the file is shared with the record's site, so the
 * station and the technician see it on the floor): announce → the bytes to the store → complete.
 */
export async function uploadMedia(api: ApiClient, owner: MediaOwner, kind: Media['kind'], file: Blob, name: string): Promise<string> {
  const base = owner.type === 'request' ? `/plant/requests/${seg(owner.id)}/files` : `/plant/jobs/${seg(owner.id)}/files`
  const bytes = await file.arrayBuffer()
  const contentType = file.type || (kind === 'PHOTO' ? 'image/jpeg' : 'audio/webm')
  const category = owner.type === 'job' && kind === 'PHOTO' && owner.category ? { category: owner.category } : {}
  const first = await api.post(base, { body: { kind, originalName: name, contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes), ...category }, schema: announced, idempotencyKey: newIdempotencyKey() })
  await putToStore(first.upload, bytes)
  const done = await api.post(`${base}/${seg(first.file.id)}/complete`, { schema: completed, idempotencyKey: newIdempotencyKey() })
  return done.file.id
}
