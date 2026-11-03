import { z } from 'zod'
import type { HandBackAction } from '@nexus/factory-domain/plant/jobs/close'
import { PROGRESS_STEPS } from '@nexus/factory-domain/plant/requests/progress'
import { JOB_STATUSES, JOB_TYPES, MACHINE_AFTER, MACHINE_STATUSES, PRIORITIES, REQUEST_STATUSES, SAFE_AFTER } from '@nexus/factory-domain/plant/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import type { MachineCard as ScanMachineCard } from '../../scan/scan-model'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * The machine problem's calls (B-W2a-73 on the API of B-W2a-35, apps/factory-api modules/plant; design floor.machine
 * SCR-179): the station's machines with their symptoms and the scanned tag's machine (`GET /plant/floor/machines`), one
 * machine's card (`GET /plant/floor/machines/:id`), the technician's My jobs (`GET /plant/floor/jobs`), one job with the
 * requests behind it (`GET /plant/jobs/:id`), the technician's moves (start, wait for parts, hand back, take back) and the
 * sign-safe of an unsafe request (a signing act: the PIN). The report itself is the floor queue's `plant.report` (saved on
 * the tablet first; floor/queue). Each answer is checked against the fields the screen reads: the floor sees no cost, no
 * supplier and no person's name (people come as kinds only). Every write carries an Idempotency-Key (floorWrite); the
 * screen keeps a move's key for a retry after the PIN or a lost answer.
 *
 * B-W2b-102 (on the API of B-W2b-96): the station's requests under way and one request's progress, the technician's queue,
 * the progress steps online first (acknowledge, on the way, "It works": queued as `plant.request.progress` under the same
 * id when the network fails), the line lead's confirmation, photos and voice notes up to a request or job and back from
 * the floor's own download route, and the one-screen close's body (action, failure code, machine after).
 */

export type MachineStatus = (typeof MACHINE_STATUSES)[number]
export type JobStatus = (typeof JOB_STATUSES)[number]
export type MachineAfter = (typeof MACHINE_AFTER)[number]
export type SafeAfter = (typeof SAFE_AFTER)[number]
export type Priority = (typeof PRIORITIES)[number]

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Place = z.infer<typeof place>

const worded = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words.default({}), icon: z.string().nullable() })
export type MachineClass = z.infer<typeof worded>

const symptom = worded.extend({ classId: z.string().nullable(), colour: z.string().nullable(), unsafe: z.boolean(), needsDetail: z.boolean(), active: z.boolean() })
export type Symptom = z.infer<typeof symptom>

/** People on the floor come as kinds only (a station, a worker, an office colleague): never a name. */
const person = z.object({ kind: z.enum(['USER', 'WORKER', 'STATION']) })

/**
 * B-W2b-96 (QHS-180): what the reporter sees of a request — acknowledged, on the way, fixed (its job handed back; a merged
 * request follows the one it joined), works again — and whether this station confirms "It works" now. No person is read.
 */
const progress = z.object({
  step: z.enum(PROGRESS_STEPS),
  acknowledgedAt: z.string().nullable(),
  onTheWayAt: z.string().nullable(),
  fixedAt: z.string().nullable(),
  worksAt: z.string().nullable(),
  closedWithoutJob: z.boolean(),
  canConfirm: z.boolean(),
})
export type RequestProgress = z.infer<typeof progress>

/** B-W2b-96 (QHS-189): a photo or voice note of a request or job (the floor looks at it through its own download route). */
const media = z.object({
  id: z.string(),
  kind: z.enum(['PHOTO', 'AUDIO']),
  /** A job's photo before or after the work. */
  category: z.enum(['BEFORE_WORK', 'AFTER_WORK']).nullable(),
  originalName: z.string(),
  contentType: z.string(),
  availableAt: z.string().nullable(),
})
export type StoredMedia = z.infer<typeof media>

const machine = z.object({
  id: z.string(),
  siteId: z.string(),
  assetNumber: z.string(),
  class: worded,
  make: z.string().nullable(),
  modelName: z.string().nullable(),
  station: place.nullable(),
  line: place.nullable(),
  workCentre: place.nullable(),
  status: z.enum(MACHINE_STATUSES),
  statusSince: z.string(),
  locked: z.boolean(),
  openRequests: z.number(),
  openJobs: z.number(),
  version: z.number(),
})
export type FloorMachine = z.infer<typeof machine>

const stationMachine = machine.extend({ symptoms: z.array(symptom) })
export type StationMachine = z.infer<typeof stationMachine>

const stationWords = z.object({ blocked: z.boolean() })

const stationAnswer = z.object({ station: place.nullable(), machines: z.array(stationMachine), found: stationMachine.nullable(), words: stationWords })
export type StationAnswer = z.infer<typeof stationAnswer>

const jobRef = z.object({ id: z.string(), number: z.string(), status: z.enum(JOB_STATUSES) })
const jobBrief = z.object({ id: z.string(), number: z.string(), type: z.enum(JOB_TYPES), status: z.enum(JOB_STATUSES), problem: z.string(), createdAt: z.string(), closedAt: z.string().nullable() })
export type JobBrief = z.infer<typeof jobBrief>

const card = z.object({ machine, openJob: jobRef.nullable(), lastJobs: z.array(jobBrief), requestsIn30Days: z.number(), repeatFailure: z.boolean() })
export type MachineCard = z.infer<typeof card>

export const requestSchema = z.object({
  id: z.string(),
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), class: worded }),
  symptom: symptom.nullable(),
  description: z.string().nullable(),
  unsafe: z.boolean(),
  reportedAt: z.string(),
  ageMinutes: z.number(),
  reportedBy: person,
  station: place.nullable(),
  status: z.enum(REQUEST_STATUSES),
  job: jobRef.nullable(),
  signedSafe: z.object({ at: z.string() }).nullable(),
  locking: z.boolean(),
  photos: z.number(),
  /** B-W2b-96: its voice notes (AUDIO files). */
  voiceNotes: z.number(),
  progress,
  /** B-W2b-96 (QHS-179): where it was sent — a team or a technician, as a kind only on the floor — and how far it escalated. */
  routing: z.object({ routedTo: z.object({ kind: z.enum(['TEAM', 'TECHNICIAN']) }).nullable(), escalationLevel: z.number() }),
  version: z.number(),
})
export type FloorRequest = z.infer<typeof requestSchema>

const machineAnswer = z.object({ card, symptoms: z.array(symptom), openRequests: z.array(requestSchema), words: stationWords })
export type MachineAnswer = z.infer<typeof machineAnswer>

export const jobSchema = z.object({
  id: z.string(),
  number: z.string(),
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean(), class: worded, station: place.nullable(), line: place.nullable() }),
  type: z.enum(JOB_TYPES),
  problem: z.string(),
  symptom: symptom.nullable(),
  priority: z.enum(PRIORITIES),
  ownership: z.enum(['MINE', 'NOBODY', 'OTHER']),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  status: z.enum(JOB_STATUSES),
  startedAt: z.string().nullable(),
  /** B-W2b-96 (QHS-190): with its failure code and the minutes from the start (the API's count, never typed). */
  handedBack: z.object({ at: z.string(), machineAfter: z.enum(MACHINE_AFTER), failureCode: z.string().nullable(), minutesSpent: z.number().nullable() }).nullable(),
  /** B-W2b-96 (QHS-180): the line lead confirmed the machine works (when; never who). */
  leadConfirmed: z.object({ at: z.string() }).nullable(),
  requestIds: z.array(z.string()),
  ageMinutes: z.number(),
  open: z.boolean(),
  createdAt: z.string(),
  version: z.number(),
})
export type FloorJob = z.infer<typeof jobSchema>

const jobsAnswer = z.object({ jobs: z.array(jobSchema) })
const jobRecord = z.object({
  job: jobSchema,
  card,
  requests: z.array(requestSchema),
  canWork: z.boolean(),
  /** B-W2b-96 (QHS-189): the job's photos (before / after) and voice notes, and its requests'. */
  files: z.array(media),
  requestFiles: z.array(media.extend({ requestId: z.string() })),
  /** B-W2b-96 (QHS-190): the minutes so far (from Start), whether "running" is held by the lock, whether it may be handed back. */
  close: z.object({ minutesSoFar: z.number().nullable(), runningHeld: z.boolean(), canHandBack: z.boolean() }),
  /** B-W2b-96 (QHS-180): this person confirms as the line lead now. */
  canConfirm: z.boolean(),
})
export type JobRecord = z.infer<typeof jobRecord>

const moveAnswer = z.object({ job: jobSchema, machine, replayed: z.boolean() })
export type MoveAnswer = z.infer<typeof moveAnswer>
const signAnswer = z.object({ request: requestSchema, machine, replayed: z.boolean() })
export type SignAnswer = z.infer<typeof signAnswer>

export const freshKey = (): string => newIdempotencyKey()

// ---- reads -------------------------------------------------------------------------------------------------------------

/** The tablet's station with its machines, and the machine of a scanned tag at this site (any state). */
export const readStation = (api: ApiClient, code?: string | null): Promise<TaskOutcome<StationAnswer>> =>
  floorRead(api, '/plant/floor/machines', { query: code ? { code: code.trim().slice(0, 40) } : undefined, schema: stationAnswer })

/** One machine: its card (now, the open job, the last three jobs), its symptoms and its open requests. */
export const readMachine = (api: ApiClient, machineId: string): Promise<TaskOutcome<MachineAnswer>> => floorRead(api, `/plant/floor/machines/${seg(machineId)}`, { schema: machineAnswer })

/** My jobs: given to me or to nobody, P1 first, then the oldest. */
export const readJobs = (api: ApiClient): Promise<TaskOutcome<FloorJob[]>> =>
  floorRead(api, '/plant/floor/jobs', { schema: jobsAnswer }).then((answer) => (answer.ok ? { ok: true as const, value: answer.value.jobs } : answer))

/** One job with its machine's card and the requests behind it (a floor technician's own, or nobody's). */
export const readJob = (api: ApiClient, jobId: string): Promise<TaskOutcome<JobRecord>> => floorRead(api, `/plant/jobs/${seg(jobId)}`, { schema: jobRecord })

// ---- writes ------------------------------------------------------------------------------------------------------------

export type TechnicianMove = 'start' | 'wait' | 'handBack' | 'reopen'
const MOVE_PATH: Readonly<Record<TechnicianMove, string>> = { start: 'start', wait: 'wait', handBack: 'hand-back', reopen: 'reopen' }

/**
 * The one-screen close's body (B-W2b-96; QHS-190): the action tile, the failure code tile, the machine after, and words
 * when the technician wrote some (needed for OTHER). The minutes are the API's (from Start), never sent.
 */
export interface HandBackBody {
  readonly action: HandBackAction
  readonly failureCode: string
  readonly machineAfter: MachineAfter
  readonly workDone?: string
}

/** A technician's move on a job, with the version read (hand back: the one-screen close's body). */
export const moveJob = (api: ApiClient, job: Pick<FloorJob, 'id' | 'version'>, move: TechnicianMove, key: string, handBack?: HandBackBody): Promise<TaskOutcome<MoveAnswer>> =>
  floorWrite(api, 'POST', `/plant/jobs/${seg(job.id)}/${MOVE_PATH[move]}`, { body: { version: job.version, ...(handBack ?? {}) }, schema: moveAnswer, idempotencyKey: key })

/** Sign an unsafe request safe (Owner answer H1: a technician, with the PIN; 403 `stepUp` until the PIN is proved). */
export const signSafe = (api: ApiClient, request: Pick<FloorRequest, 'id' | 'version'>, body: { note: string; machineAfter: SafeAfter }, key: string): Promise<TaskOutcome<SignAnswer>> =>
  floorWrite(api, 'POST', `/plant/requests/${seg(request.id)}/sign-safe`, { body: { version: request.version, ...body }, schema: signAnswer, idempotencyKey: key })

// ---- after the report: progress (B-W2b-96; QHS-180) -------------------------------------------------------------------

const stationRequests = z.object({ stationId: z.string().nullable(), requests: z.array(requestSchema) })
export type StationRequests = z.infer<typeof stationRequests>

const floorRequest = z.object({ request: requestSchema, files: z.array(media), canAcknowledge: z.boolean(), canGo: z.boolean(), canConfirm: z.boolean() })
export type FloorRequestRecord = z.infer<typeof floorRequest>

const queueAnswer = z.object({ requests: z.array(z.object({ request: requestSchema, toMe: z.boolean(), canAcknowledge: z.boolean(), canGo: z.boolean() })) })
export type QueueEntry = z.infer<typeof queueAnswer>['requests'][number]

/** The station's requests still under way (this tablet's station, or this tablet): 7 days, not closed, not yet confirmed. */
export const readStationRequests = (api: ApiClient): Promise<TaskOutcome<StationRequests>> => floorRead(api, '/plant/floor/requests', { schema: stationRequests })

/** One request of the site: its progress, its photos and voice notes, what this person may do now. */
export const readFloorRequest = (api: ApiClient, requestId: string): Promise<TaskOutcome<FloorRequestRecord>> => floorRead(api, `/plant/floor/requests/${seg(requestId)}`, { schema: floorRequest })

/** The technician's queue: the site's open requests, routed or escalated to me first, then the ones that lock a machine. */
export const readQueue = (api: ApiClient): Promise<TaskOutcome<QueueEntry[]>> =>
  floorRead(api, '/plant/floor/queue', { schema: queueAnswer }).then((answer) => (answer.ok ? { ok: true as const, value: answer.value.requests } : answer))

export type ProgressMove = 'ACKNOWLEDGE' | 'ON_THE_WAY' | 'WORKS_AGAIN'
const STEP_PATH: Readonly<Record<ProgressMove, string>> = { ACKNOWLEDGE: 'acknowledge', ON_THE_WAY: 'on-the-way', WORKS_AGAIN: 'works' }

const stepAnswer = z.object({ request: requestSchema, replayed: z.boolean() })
export type StepAnswer = z.infer<typeof stepAnswer>

/**
 * The Idempotency-Key of a progress step tried online: the key the office gives the same step when it comes through the
 * queue (`<device>.<client event id>`, platform/floor-sync sync.ts). So the try and the queued retry are ONE command: a
 * retry after a lost answer is answered from the try's receipt, never refused as done already (B-W2b-77).
 */
export const stepKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

/** One progress step on the floor, without the version: a step is set once, and the queued retry carries none either. */
export const postStep = (api: ApiClient, requestId: string, move: ProgressMove, key: string): Promise<TaskOutcome<StepAnswer>> =>
  floorWrite(api, 'POST', `/plant/floor/requests/${seg(requestId)}/${STEP_PATH[move]}`, { body: {}, schema: stepAnswer, idempotencyKey: key })

/** A progress step, online first: a network failure keeps it on the tablet (`plant.request.progress`) under the try's id. */
export const stepOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, requestId: string, move: ProgressMove) =>
  onlineFirst(queue, { online, kind: 'plant.request.progress', payload: { requestId, step: move }, attempt: (clientEventId) => postStep(api, requestId, move, stepKey(deviceId, clientEventId)) })

const confirmAnswer = z.object({ job: jobSchema, replayed: z.boolean() })

/** The line lead confirms the machine works (floor.lead; once, while the job is handed back). Online only: a signing act. */
export const confirmAsLead = (api: ApiClient, jobId: string, key: string): Promise<TaskOutcome<z.infer<typeof confirmAnswer>>> =>
  floorWrite(api, 'POST', `/plant/floor/jobs/${seg(jobId)}/confirm`, { body: {}, schema: confirmAnswer, idempotencyKey: key })

// ---- photos and voice notes (B-W2b-96; QHS-189) ----------------------------------------------------------------------------

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string() }) })

/** Where a photo or voice note goes: a request (plant.report) or a job (plant.jobs.work; a photo before or after the work). */
export type MediaOwner = { readonly type: 'request'; readonly id: string } | { readonly type: 'job'; readonly id: string; readonly category: 'BEFORE_WORK' | 'AFTER_WORK' | null }

/** The content type the API checks: the blob's, without its codec parameters. */
export const contentTypeOf = (blob: Pick<Blob, 'type'>, fallback: string): string => (blob.type || fallback).split(';')[0]!.trim()

/**
 * A photo or voice note onto a request or job: announced with its size and SHA-256, its bytes PUT straight to the store,
 * then confirmed (the API checks the type and size, the store's copy and the scan). Each step's failure stops it.
 */
export async function uploadMedia(api: ApiClient, owner: MediaOwner, kind: 'PHOTO' | 'AUDIO', file: Blob, name: string): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const base = owner.type === 'request' ? `/plant/requests/${seg(owner.id)}/files` : `/plant/jobs/${seg(owner.id)}/files`
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const contentType = contentTypeOf(file, kind === 'PHOTO' ? 'image/jpeg' : 'audio/webm')
  const category = owner.type === 'job' && kind === 'PHOTO' ? { category: owner.category } : {}
  const first = await floorWrite(api, 'POST', base, { body: { kind, originalName: name, contentType, sizeBytes: bytes.byteLength, sha256, ...category }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: completed })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}

const download = z.object({ download: presignedSchema })

/**
 * A photo or voice note to look at or listen to on the tablet: the floor's own download route (a floor role holds no files
 * right), the bytes read with the presigned GET, kept as a blob in this page only (the caller frees it).
 */
export async function openMedia(api: ApiClient, file: Pick<StoredMedia, 'id' | 'contentType'>): Promise<TaskOutcome<Blob>> {
  const answer = await floorRead(api, `/plant/floor/files/${seg(file.id)}/download`, { schema: download })
  if (!answer.ok) return answer
  try {
    const bytes = await readFromStore(answer.value.download)
    return { ok: true, value: new Blob([bytes as BlobPart], { type: file.contentType }) }
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
}

// ---- Scan anything's machine card (design floor.scan "Machine (W2a): status and open job") -----------------------------

/**
 * A free code read as a machine's tag (its QR holds the asset number): the machine of this site with that number in any
 * state, with its open job; null when no machine has it. Throws the API's error otherwise (Scan anything says it).
 */
export async function lookupMachine(api: ApiClient, code: string): Promise<ScanMachineCard | null> {
  try {
    const { found } = await api.get('/plant/floor/machines', { query: { code: code.trim().slice(0, 40) }, schema: stationAnswer })
    if (!found) return null
    const { card } = await api.get(`/plant/floor/machines/${seg(found.id)}`, { schema: machineAnswer })
    return {
      kind: 'machine',
      id: found.id,
      code: found.assetNumber,
      type: { labelIt: found.class.labelIt, labelEn: found.class.labelEn, icon: found.class.icon },
      makeModel: [found.make, found.modelName].filter(Boolean).join(' ') || null,
      station: found.station ? `${found.station.code} · ${found.station.name}` : null,
      line: found.line?.code ?? null,
      status: card.machine.status,
      statusSince: card.machine.statusSince,
      locked: card.machine.locked,
      openJob: card.openJob ? { number: card.openJob.number, status: card.openJob.status } : null,
      openRequests: card.machine.openRequests,
    }
  } catch (error) {
    if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid')) return null
    throw error
  }
}
