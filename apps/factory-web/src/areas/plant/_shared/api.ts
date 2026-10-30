import { z } from 'zod'
import {
  CLOSE_REASONS,
  JOB_SOURCES,
  JOB_STATUSES,
  JOB_TILES,
  JOB_TYPES,
  MACHINE_AFTER,
  MACHINE_STATUSES,
  MACHINE_TILES,
  MANUAL_JOB_SOURCES,
  PRIORITIES,
  REQUEST_STATUSES,
  REQUEST_TILES,
  SAFE_AFTER,
} from '@nexus/factory-domain/plant/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, completeUpload, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of the Plant area's maintenance pages (B-W2a-53 on the API of B-W2a-35, apps/factory-api modules/plant):
 * Machine requests (SCR-148), Maintenance jobs (SCR-149), Machines & tools (SCR-150), with the answer's shape checked
 * (zod; unknown fields are dropped). A machine's purchase cost carries the cost grain: absent (never null) without it.
 * People are `{ kind, id, name }`: an office user by name; a floor worker by name only inside one record; a station by
 * its code. Every write is one command with its own Idempotency-Key and the version the screen read. The API's English
 * is never drawn: the screens say their own words from codes (a plant refusal is `refusal/<CODE>` + `fix`).
 */

export type MachineStatus = (typeof MACHINE_STATUSES)[number]
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
export type JobStatus = (typeof JOB_STATUSES)[number]
export type JobType = (typeof JOB_TYPES)[number]
export type JobSource = (typeof JOB_SOURCES)[number]
export type ManualJobSource = (typeof MANUAL_JOB_SOURCES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type CloseReason = (typeof CLOSE_REASONS)[number]
export type MachineAfter = (typeof MACHINE_AFTER)[number]
export type SafeAfter = (typeof SAFE_AFTER)[number]
export type RequestTile = (typeof REQUEST_TILES)[number]
export type JobTile = (typeof JOB_TILES)[number]
export type MachineTile = (typeof MACHINE_TILES)[number]

export { CLOSE_REASONS, JOB_STATUSES, JOB_TILES, JOB_TYPES, MACHINE_AFTER, MACHINE_STATUSES, MACHINE_TILES, MANUAL_JOB_SOURCES, PRIORITIES, REQUEST_STATUSES, REQUEST_TILES, SAFE_AFTER }

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Place = z.infer<typeof place>

const classSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable() })
export type MachineClass = z.infer<typeof classSchema>

const symptomSchema = z.object({
  id: z.string(),
  code: z.string(),
  classId: z.string().nullable(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: words,
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  unsafe: z.boolean(),
  needsDetail: z.boolean(),
  active: z.boolean(),
})
export type Symptom = z.infer<typeof symptomSchema>

const personSchema = z.object({ kind: z.enum(['USER', 'WORKER', 'STATION']), id: z.string().nullable(), name: z.string().nullable() })
export type Person = z.infer<typeof personSchema>

export const machineSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  assetNumber: z.string(),
  class: classSchema,
  make: z.string().nullable(),
  modelName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  year: z.number().nullable(),
  station: place.nullable(),
  line: place.nullable(),
  workCentre: place.nullable(),
  supplier: place.nullable(),
  /** Minor units of the company's currency; absent without the cost grain. */
  purchaseCost: z.number().nullable().optional(),
  status: z.enum(MACHINE_STATUSES),
  statusSince: z.string(),
  statusReason: z.string().nullable(),
  locked: z.boolean(),
  note: z.string().nullable(),
  openRequests: z.number(),
  openJobs: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Machine = z.infer<typeof machineSchema>

const jobRef = z.object({ id: z.string(), number: z.string(), status: z.enum(JOB_STATUSES) })

export const requestSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), class: classSchema }),
  symptom: symptomSchema.nullable(),
  description: z.string().nullable(),
  unsafe: z.boolean(),
  reportedAt: z.string(),
  ageMinutes: z.number(),
  reportedBy: personSchema,
  station: place.nullable(),
  status: z.enum(REQUEST_STATUSES),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: personSchema.nullable(),
  job: jobRef.nullable(),
  mergedIntoId: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: personSchema.nullable(),
  closeReason: z.enum(CLOSE_REASONS).nullable(),
  closeNote: z.string().nullable(),
  signedSafe: z.object({ at: z.string(), by: personSchema, note: z.string().nullable() }).nullable(),
  locking: z.boolean(),
  duplicates: z.number(),
  photos: z.number(),
  version: z.number(),
})
export type MaintenanceRequest = z.infer<typeof requestSchema>

export const jobSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  number: z.string(),
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean(), class: classSchema, station: place.nullable(), line: place.nullable() }),
  type: z.enum(JOB_TYPES),
  source: z.enum(JOB_SOURCES),
  problem: z.string(),
  symptom: symptomSchema.nullable(),
  priority: z.enum(PRIORITIES),
  assignee: personSchema.nullable(),
  ownership: z.enum(['MINE', 'NOBODY', 'OTHER']),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  status: z.enum(JOB_STATUSES),
  startedAt: z.string().nullable(),
  handedBack: z.object({ at: z.string(), by: personSchema, workDone: z.string(), machineAfter: z.enum(MACHINE_AFTER) }).nullable(),
  closedAt: z.string().nullable(),
  closedBy: personSchema.nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  requestIds: z.array(z.string()),
  ageMinutes: z.number(),
  open: z.boolean(),
  createdAt: z.string(),
  createdBy: personSchema.nullable(),
  version: z.number(),
})
export type MaintenanceJob = z.infer<typeof jobSchema>

const jobBrief = z.object({ id: z.string(), number: z.string(), type: z.enum(JOB_TYPES), status: z.enum(JOB_STATUSES), problem: z.string(), createdAt: z.string(), closedAt: z.string().nullable() })
export type JobBrief = z.infer<typeof jobBrief>

const cardSchema = z.object({ machine: machineSchema, openJob: jobRef.nullable(), lastJobs: z.array(jobBrief), requestsIn30Days: z.number(), repeatFailure: z.boolean() })
export type MachineCard = z.infer<typeof cardSchema>

const requestRecordSchema = z.object({
  request: requestSchema,
  card: cardSchema,
  duplicates: z.array(requestSchema),
  photos: z.array(z.object({ id: z.string(), originalName: z.string(), contentType: z.string() })),
  canTriage: z.boolean(),
  canSignSafe: z.boolean(),
})
export type RequestRecord = z.infer<typeof requestRecordSchema>

const jobRecordSchema = z.object({ job: jobSchema, card: cardSchema, requests: z.array(requestSchema), canManage: z.boolean(), canWork: z.boolean() })
export type JobRecord = z.infer<typeof jobRecordSchema>

const machineRecordSchema = z.object({ card: cardSchema, openRequests: z.array(requestSchema), history: z.array(jobSchema), canManage: z.boolean(), canReport: z.boolean() })
export type MachineRecord = z.infer<typeof machineRecordSchema>

const requestTilesSchema = z.object({
  tiles: z.object({ NEW: z.object({ count: z.number(), oldestMinutes: z.number().nullable() }), UNSAFE: z.number(), DOWN: z.number(), WAITING: z.number(), DUPLICATES: z.number() }),
})
export type RequestTiles = z.infer<typeof requestTilesSchema>['tiles']
const jobTilesSchema = z.object({ tiles: z.object({ OPEN: z.number(), OVERDUE: z.number(), UNSAFE: z.number(), WAITING_PARTS: z.number(), CLOSED_THIS_WEEK: z.number() }) })
export type JobTiles = z.infer<typeof jobTilesSchema>['tiles']
const machineTilesSchema = z.object({ tiles: z.object({ DOWN: z.number(), DO_NOT_USE: z.number(), UNDER_MAINTENANCE: z.number() }), locked: z.number(), inUse: z.number() })
export type MachineTiles = z.infer<typeof machineTilesSchema>

const placesSchema = z.object({
  sites: z.array(
    z.object({
      id: z.string(),
      companyId: z.string(),
      code: z.string(),
      name: z.string(),
      lines: z.array(place),
      workCentres: z.array(place),
      stations: z.array(place.extend({ lineId: z.string().nullable(), workCentreId: z.string() })),
    }),
  ),
})
export type PlantSite = z.infer<typeof placesSchema>['sites'][number]

const techniciansSchema = z.object({ technicians: z.array(z.object({ kind: z.enum(['USER', 'WORKER']), id: z.string(), name: z.string(), me: z.boolean() })), floorListed: z.boolean() })
export type Technician = z.infer<typeof techniciansSchema>['technicians'][number]
export type Technicians = z.infer<typeof techniciansSchema>

const supplierSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string() })
export type SupplierChoice = z.infer<typeof supplierSchema>

// ---- paths -----------------------------------------------------------------------------------------------------------------

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

// ---- lists of the group: classes and symptoms ------------------------------------------------------------------------------

export const listClasses = (api: ApiClient, signal?: AbortSignal) =>
  api.get('/plant/classes', { query: { active: 'true' }, schema: z.object({ classes: z.array(classSchema.extend({ active: z.boolean() })) }), signal }).then((answer) => answer.classes)

export const listSymptoms = (api: ApiClient, classId: string | null, signal?: AbortSignal) =>
  api.get('/plant/symptoms', { query: clean({ classId, active: 'true' }), schema: z.object({ symptoms: z.array(symptomSchema) }), signal }).then((answer) => answer.symptoms)

// ---- places, technicians, suppliers (the pickers) ----------------------------------------------------------------------------

export const plantPlaces = (api: ApiClient, signal?: AbortSignal) => api.get('/plant/places', { schema: placesSchema, signal }).then((answer) => answer.sites)

export const plantTechnicians = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/plant/technicians', { query: { siteId }, schema: techniciansSchema, signal })

export const findSuppliers = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.get('/parties', { query: clean({ role: 'SUPPLIER', q: q.trim(), limit: 20 }), schema: z.object({ parties: z.array(supplierSchema) }), signal }).then((answer) => answer.parties)

// ---- machines --------------------------------------------------------------------------------------------------------------

export interface MachinesQuery {
  siteId?: string | null
  status?: readonly MachineStatus[] | null
  tile?: MachineTile | null
  classId?: string | null
  q?: string | null
  code?: string | null
  cursor?: string | null
  limit?: number
}

export const listMachines = (api: ApiClient, query: MachinesQuery, signal?: AbortSignal) =>
  api.get('/plant/machines', {
    query: clean({ siteId: query.siteId, status: query.status?.length ? query.status.join(',') : undefined, tile: query.tile, classId: query.classId, q: query.q?.trim(), code: query.code?.trim(), cursor: query.cursor, limit: query.limit }),
    schema: z.object({ machines: z.array(machineSchema), nextCursor: z.string().nullable() }),
    signal,
  })

export const machineTiles = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/plant/machines/counts', { query: clean({ siteId }), schema: machineTilesSchema, signal })

export const getMachine = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/machines/${seg(id)}`, { schema: machineRecordSchema, signal })

export interface MachineFields {
  classId?: string
  make?: string | null
  modelName?: string | null
  serialNumber?: string | null
  year?: number | null
  stationId?: string | null
  workCentreId?: string | null
  supplierId?: string | null
  purchaseCost?: number | null
  note?: string | null
}

const oneMachine = z.object({ machine: machineSchema })

export const createMachine = (api: ApiClient, body: MachineFields & { siteId: string; assetNumber: string; classId: string }) =>
  api.post('/plant/machines', { body, schema: oneMachine, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.machine)

export const updateMachine = (api: ApiClient, id: string, body: MachineFields & { version: number }) =>
  api.request('PATCH', `/plant/machines/${seg(id)}`, { body, schema: oneMachine, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.machine)

export const retireMachine = (api: ApiClient, id: string, body: { version: number; reason: string }) =>
  api.post(`/plant/machines/${seg(id)}/retire`, { body, schema: oneMachine, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.machine)

// ---- requests --------------------------------------------------------------------------------------------------------------

export interface RequestsQuery {
  siteId?: string | null
  status?: readonly RequestStatus[] | null
  open?: boolean
  unsafe?: boolean
  tile?: RequestTile | null
  machineId?: string | null
  cursor?: string | null
  limit?: number
}

export const listRequests = (api: ApiClient, query: RequestsQuery, signal?: AbortSignal) =>
  api.get('/plant/requests', {
    query: clean({
      siteId: query.siteId,
      status: query.status?.length ? query.status.join(',') : undefined,
      open: query.open ? 'true' : undefined,
      unsafe: query.unsafe === undefined ? undefined : String(query.unsafe),
      tile: query.tile,
      machineId: query.machineId,
      cursor: query.cursor,
      limit: query.limit,
    }),
    schema: z.object({ requests: z.array(requestSchema), nextCursor: z.string().nullable(), truncated: z.boolean() }),
    signal,
  })

export const requestTiles = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/plant/requests/counts', { query: clean({ siteId }), schema: requestTilesSchema, signal }).then((answer) => answer.tiles)

export const getRequest = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/requests/${seg(id)}`, { schema: requestRecordSchema, signal })

export interface ReportBody {
  machineId?: string
  assetNumber?: string
  symptomId?: string
  description?: string
  unsafe?: boolean
  down: boolean
}

const reportAnswer = z.object({ request: requestSchema, machine: machineSchema, replayed: z.boolean() })
export const reportProblem = (api: ApiClient, body: ReportBody, idempotencyKey: string) => api.post('/plant/requests', { body, schema: reportAnswer, idempotencyKey })

const triageAnswer = z.object({ request: requestSchema, machine: machineSchema, job: jobSchema.nullable(), replayed: z.boolean() })
export type TriageAnswer = z.infer<typeof triageAnswer>

export const acknowledgeRequest = (api: ApiClient, id: string, version: number) => api.post(`/plant/requests/${seg(id)}/acknowledge`, { body: { version }, schema: triageAnswer, idempotencyKey: newIdempotencyKey() })

export interface MakeJobBody {
  version: number
  jobId?: string
  type?: JobType
  problem?: string
  priority?: Priority
  assigneeId?: string | null
  assigneeWorkerId?: string | null
  dueAt?: string | null
  plan?: boolean
}

export const makeJobOfRequest = (api: ApiClient, id: string, body: MakeJobBody) => api.post(`/plant/requests/${seg(id)}/job`, { body, schema: triageAnswer, idempotencyKey: newIdempotencyKey() })

export const mergeRequest = (api: ApiClient, id: string, body: { version: number; intoId: string }) => api.post(`/plant/requests/${seg(id)}/merge`, { body, schema: triageAnswer, idempotencyKey: newIdempotencyKey() })

export const closeRequest = (api: ApiClient, id: string, body: { version: number; reason: CloseReason; note?: string; keepDown?: boolean }) =>
  api.post(`/plant/requests/${seg(id)}/close`, { body, schema: triageAnswer, idempotencyKey: newIdempotencyKey() })

/** A signing act (H1): the office asks a fresh two-factor code (403 `stepUp` → the code → this again, same key). */
export const signSafe = (api: ApiClient, id: string, body: { version: number; note: string; machineAfter?: SafeAfter }, idempotencyKey: string) =>
  api.post(`/plant/requests/${seg(id)}/sign-safe`, { body, schema: z.object({ request: requestSchema, machine: machineSchema, replayed: z.boolean() }), idempotencyKey })

/** A photo of a request (files on its record, kind PHOTO): announce → the bytes to the store → complete. */
export async function uploadRequestPhoto(api: ApiClient, request: { id: string; companyId: string }, file: Blob, name: string): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: request.companyId,
    record: { type: 'MaintenanceRequest', id: request.id },
    kind: 'PHOTO',
    name,
    contentType: file.type || 'image/jpeg',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

/** A photo's address for an <img> (the presigned GET lives 60 seconds; a same-origin path goes through this app's /api). */
export async function photoAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

// ---- jobs ------------------------------------------------------------------------------------------------------------------

export interface JobsQuery {
  siteId?: string | null
  status?: readonly JobStatus[] | null
  open?: boolean
  tile?: JobTile | null
  machineId?: string | null
  mine?: boolean
  cursor?: string | null
  limit?: number
}

export const listJobs = (api: ApiClient, query: JobsQuery, signal?: AbortSignal) =>
  api.get('/plant/jobs', {
    query: clean({
      siteId: query.siteId,
      status: query.status?.length ? query.status.join(',') : undefined,
      open: query.open ? 'true' : undefined,
      tile: query.tile,
      machineId: query.machineId,
      mine: query.mine ? 'true' : undefined,
      cursor: query.cursor,
      limit: query.limit,
    }),
    schema: z.object({ jobs: z.array(jobSchema), nextCursor: z.string().nullable() }),
    signal,
  })

export const jobTiles = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/plant/jobs/counts', { query: clean({ siteId }), schema: jobTilesSchema, signal }).then((answer) => answer.tiles)

export const getJob = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/jobs/${seg(id)}`, { schema: jobRecordSchema, signal })

export interface NewJobBody {
  machineId: string
  type: JobType
  problem: string
  priority?: Priority
  source?: ManualJobSource
  assigneeId?: string | null
  assigneeWorkerId?: string | null
  dueAt?: string | null
  plan?: boolean
}

export const createJob = (api: ApiClient, body: NewJobBody) => api.post('/plant/jobs', { body, schema: z.object({ job: jobSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.job)

export interface JobChange {
  version: number
  type?: JobType
  problem?: string
  priority?: Priority
  dueAt?: string | null
  assigneeId?: string | null
  assigneeWorkerId?: string | null
}

export const updateJob = (api: ApiClient, id: string, body: JobChange) =>
  api.request('PATCH', `/plant/jobs/${seg(id)}`, { body, schema: z.object({ job: jobSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.job)

export const assignJobs = (api: ApiClient, body: { jobs: { id: string; version: number }[]; assigneeId: string | null; assigneeWorkerId: string | null }) =>
  api.post('/plant/jobs/assign', { body, schema: z.object({ jobs: z.array(jobSchema), replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.jobs)

export const JOB_MOVES = ['plan', 'start', 'wait', 'handBack', 'reopen', 'close', 'cancel'] as const
export type JobMove = (typeof JOB_MOVES)[number]
const MOVE_PATH: Readonly<Record<JobMove, string>> = { plan: 'plan', start: 'start', wait: 'wait', handBack: 'hand-back', reopen: 'reopen', close: 'close', cancel: 'cancel' }

export type MoveBody = { version: number } & ({} | { workDone: string; machineAfter: MachineAfter } | { reason: string })

export const moveJob = (api: ApiClient, id: string, move: JobMove, body: MoveBody) =>
  api.post(`/plant/jobs/${seg(id)}/${MOVE_PATH[move]}`, { body, schema: z.object({ job: jobSchema, machine: machineSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })
