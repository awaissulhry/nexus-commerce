import { z } from 'zod'
import { JOB_STATUSES, JOB_TYPES, MACHINE_AFTER, MACHINE_STATUSES, PRIORITIES, REQUEST_STATUSES, SAFE_AFTER } from '@nexus/factory-domain/plant/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
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
  machine: z.object({ id: z.string(), assetNumber: z.string() }),
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
  handedBack: z.object({ at: z.string(), machineAfter: z.enum(MACHINE_AFTER) }).nullable(),
  requestIds: z.array(z.string()),
  ageMinutes: z.number(),
  open: z.boolean(),
  createdAt: z.string(),
  version: z.number(),
})
export type FloorJob = z.infer<typeof jobSchema>

const jobsAnswer = z.object({ jobs: z.array(jobSchema) })
const jobRecord = z.object({ job: jobSchema, card, requests: z.array(requestSchema), canWork: z.boolean() })
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

/** A technician's move on a job, with the version read (hand back: what was done and the machine's state after). */
export const moveJob = (api: ApiClient, job: Pick<FloorJob, 'id' | 'version'>, move: TechnicianMove, key: string, handBack?: { workDone: string; machineAfter: MachineAfter }): Promise<TaskOutcome<MoveAnswer>> =>
  floorWrite(api, 'POST', `/plant/jobs/${seg(job.id)}/${MOVE_PATH[move]}`, { body: { version: job.version, ...(handBack ?? {}) }, schema: moveAnswer, idempotencyKey: key })

/** Sign an unsafe request safe (Owner answer H1: a technician, with the PIN; 403 `stepUp` until the PIN is proved). */
export const signSafe = (api: ApiClient, request: Pick<FloorRequest, 'id' | 'version'>, body: { note: string; machineAfter: SafeAfter }, key: string): Promise<TaskOutcome<SignAnswer>> =>
  floorWrite(api, 'POST', `/plant/requests/${seg(request.id)}/sign-safe`, { body: { version: request.version, ...body }, schema: signAnswer, idempotencyKey: key })

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
