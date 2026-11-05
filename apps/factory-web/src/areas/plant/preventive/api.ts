import { z } from 'zod'
import { CHECK_INTERVAL_UNITS, CHECK_OUTCOMES, CHECK_PLAN_STATUSES, DUE_STATES, type CheckIntervalUnit, type CheckOutcome } from '@nexus/factory-domain/plant/statutory/rules'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { JOB_STATUSES, MACHINE_STATUSES } from '../_shared/api'

/**
 * Every call of Plant › Maintenance › Preventive & statutory checks (SCR-266; B-W2b-142 on the merged API of B-W2b-124,
 * apps/factory-api modules/plant/statutory): the tiles, the calendar, the plans, the check register, the check types, a
 * result with its job and lock, the body's report files and the check report PDF; the pickers read the plant's machines
 * and technicians and the group's organisations. Each answer's shape is checked (zod mirrors of the API's contracts;
 * unknown fields are dropped). Reading is plant.view; every write plant.checks.manage (a job also plant.jobs.manage, a lock
 * plant.report), each with its own Idempotency-Key and, on a plan, the version read. The API's English messages are never
 * shown: the screens say their own words from the codes.
 */

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Record<string, string | number | boolean> => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Record<string, string | number | boolean>

const named = z.object({ id: z.string(), name: z.string().nullable() })
const site = z.object({ id: z.string(), code: z.string(), name: z.string() })
const machineBrief = z.object({ id: z.string(), assetNumber: z.string(), make: z.string().nullable(), modelName: z.string().nullable(), status: z.enum(MACHINE_STATUSES), classId: z.string(), siteId: z.string() })
const typeBrief = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), legalBasis: z.string(), outsideBody: z.boolean(), keptYears: z.number().int(), active: z.boolean() })
export type TypeBrief = z.infer<typeof typeBrief>

// ---- check types (Plant settings keeps them; New plan picks one) ---------------------------------------------------------------

export const typeSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  legalBasis: z.string(),
  machineClass: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  defaultInterval: z.number().int(),
  defaultIntervalUnit: z.enum(CHECK_INTERVAL_UNITS),
  outsideBody: z.boolean(),
  keptYears: z.number().int(),
  active: z.boolean(),
})
export type CheckType = z.infer<typeof typeSchema>

/** GET /plant/checks/types?active=true&classId= (plant.view): the active types of the machine's class and those for any machine. */
export const readTypes = async (api: ApiClient, classId: string | null, signal?: AbortSignal) =>
  (await api.get('/plant/checks/types', { query: clean({ active: 'true', classId }), schema: z.object({ types: z.array(typeSchema), canManage: z.boolean(), leastRetentionYears: z.number().int() }), signal })).types

// ---- the page's reads --------------------------------------------------------------------------------------------------------

const countsAnswer = z.object({ tiles: z.object({ OVERDUE: z.number().int(), DUE_SOON: z.number().int(), REPORTS_MISSING: z.number().int() }), today: z.string() })
export type CountsAnswer = z.infer<typeof countsAnswer>

/** GET /plant/checks/counts (plant.view): checks overdue, due in 30 days, reports missing. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/plant/checks/counts', { query: clean({ siteId }), schema: countsAnswer, signal })

export const chipSchema = z.object({
  kind: z.enum(['DUE', 'PROJECTED', 'DONE']),
  date: z.string(),
  state: z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED', 'DONE']),
  planId: z.string().nullable(),
  resultId: z.string().nullable(),
  site,
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean() }),
  checkType: typeBrief,
  outsideBody: z.string().nullable(),
  outcome: z.enum(CHECK_OUTCOMES).nullable(),
})
export type Chip = z.infer<typeof chipSchema>

const calendarAnswer = z.object({ from: z.string(), to: z.string(), today: z.string(), chips: z.array(chipSchema), canManage: z.boolean() })
export type CalendarAnswer = z.infer<typeof calendarAnswer>

/** GET /plant/checks/calendar?from&to (plant.view; at most 400 days): next due dates, later checks by the interval, checks done. */
export const readCalendar = (api: ApiClient, window: { from: string; to: string; siteId: string | null }, signal?: AbortSignal) =>
  api.get('/plant/checks/calendar', { query: clean({ from: window.from, to: window.to, siteId: window.siteId }), schema: calendarAnswer, signal })

// ---- plans --------------------------------------------------------------------------------------------------------------------

export const planSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  site,
  machine: machineBrief.extend({ locked: z.boolean() }),
  checkType: typeBrief,
  interval: z.number().int(),
  intervalUnit: z.enum(CHECK_INTERVAL_UNITS),
  outsideBody: named.nullable(),
  owner: named.nullable(),
  firstDueOn: z.string(),
  nextDueOn: z.string(),
  reminderDays: z.number().int(),
  reminderFrom: z.string(),
  lastRemindedAt: z.string().nullable(),
  lastDone: z.object({ resultId: z.string(), performedOn: z.string(), outcome: z.enum(CHECK_OUTCOMES) }).nullable(),
  due: z.object({ state: z.enum(DUE_STATES), days: z.number().int() }),
  status: z.enum(CHECK_PLAN_STATUSES),
  endedAt: z.string().nullable(),
  endedReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})
export type CheckPlan = z.infer<typeof planSchema>

const plansAnswer = z.object({ plans: z.array(planSchema), nextCursor: z.string().nullable(), today: z.string() })
export type PlansAnswer = z.infer<typeof plansAnswer>

export interface PlansQuery {
  siteId: string | null
  status?: 'ACTIVE' | 'ENDED'
  due?: 'OVERDUE' | 'DUE_SOON' | null
  machineId?: string | null
  checkTypeId?: string | null
  cursor?: string | null
  limit?: number
}

/** GET /plant/checks/plans (plant.view): the grid, soonest due first (a cursor `<day>|<id>`). */
export const readPlans = (api: ApiClient, query: PlansQuery, signal?: AbortSignal) =>
  api.get('/plant/checks/plans', { query: clean({ siteId: query.siteId, status: query.status, due: query.due, machineId: query.machineId, checkTypeId: query.checkTypeId, cursor: query.cursor, limit: query.limit ?? 100 }), schema: plansAnswer, signal })

// ---- results (the check register) ------------------------------------------------------------------------------------------------

const reportFile = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: z.string().nullable() })
export type ReportFile = z.infer<typeof reportFile>
const jobBrief = z.object({ id: z.string(), number: z.string(), status: z.enum(JOB_STATUSES) })

export const resultSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  site,
  machine: machineBrief,
  checkType: typeBrief,
  planId: z.string().nullable(),
  performedOn: z.string(),
  outcome: z.enum(CHECK_OUTCOMES),
  remarks: z.string().nullable(),
  performedBy: z.string(),
  outsideBody: named.nullable(),
  nextDueOn: z.string().nullable(),
  keptUntil: z.string(),
  corrects: z.object({ id: z.string(), performedOn: z.string() }).nullable(),
  correctionReason: z.string().nullable(),
  correctedBy: z.object({ id: z.string(), performedOn: z.string() }).nullable(),
  inForce: z.boolean(),
  reports: z.array(reportFile),
  reportOnFile: z.boolean(),
  jobs: z.array(jobBrief),
  recordedAt: z.string(),
  recordedBy: named.nullable(),
})
export type CheckResult = z.infer<typeof resultSchema>

const resultsAnswer = z.object({ results: z.array(resultSchema), nextCursor: z.string().nullable(), today: z.string(), from: z.string().nullable(), to: z.string().nullable() })
export type ResultsAnswer = z.infer<typeof resultsAnswer>

export interface ResultsQuery {
  siteId: string | null
  planId?: string | null
  outcome?: CheckOutcome | null
  from?: string | null
  to?: string | null
  reportMissing?: boolean
  cursor?: string | null
  limit?: number
}

/** GET /plant/checks/results (plant.view): the register, newest check first (a cursor `<day>|<id>`). */
export const readResults = (api: ApiClient, query: ResultsQuery, signal?: AbortSignal) =>
  api.get('/plant/checks/results', {
    query: clean({ siteId: query.siteId, planId: query.planId, outcome: query.outcome, from: query.from, to: query.to, reportMissing: query.reportMissing ? 'true' : undefined, cursor: query.cursor, limit: query.limit ?? 100 }),
    schema: resultsAnswer,
    signal,
  })

const planRecord = z.object({ plan: planSchema, results: z.array(resultSchema), canManage: z.boolean(), canRecord: z.boolean() })
export type PlanRecord = z.infer<typeof planRecord>

/** GET /plant/checks/plans/:id (plant.view): the plan with its results, newest first. */
export const readPlan = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/checks/plans/${seg(id)}`, { schema: planRecord, signal })

const resultRecord = z.object({
  result: resultSchema,
  plan: planSchema.nullable(),
  corrections: z.array(resultSchema),
  machine: z.object({ id: z.string(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean() }),
  canCorrect: z.boolean(),
  canMakeJob: z.boolean(),
  canLock: z.boolean(),
  canAddReport: z.boolean(),
})
export type ResultRecord = z.infer<typeof resultRecord>

/** GET /plant/checks/results/:id (plant.view): the result with its plan, its corrections and what may be done now. */
export const readResult = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/checks/results/${seg(id)}`, { schema: resultRecord, signal })

// ---- writes -----------------------------------------------------------------------------------------------------------------------

export interface NewPlanBody {
  machineId: string
  checkTypeId: string
  interval: number
  intervalUnit: CheckIntervalUnit
  outsideBodyPartyId: string | null
  ownerId: string | null
  firstDueOn: string
  reminderDays: number
  note?: string
  replaceReason?: string
}

const planAnswer = z.object({ plan: planSchema, replayed: z.boolean() })

/** POST /plant/checks/plans (plant.checks.manage): PLAN_EXISTS unless `replaceReason` ends the active plan in the same step. */
export const createPlan = (api: ApiClient, body: NewPlanBody, idempotencyKey: string) => api.post('/plant/checks/plans', { body, schema: planAnswer.extend({ replacedPlanId: z.string().nullable() }), idempotencyKey })

/** POST /plant/checks/plans/:id/move (plant.checks.manage): "Move a check" — the new due date and why (the audit row keeps it). */
export const movePlan = async (api: ApiClient, id: string, body: { version: number; nextDueOn: string; reason: string }, idempotencyKey: string) =>
  (await api.post(`/plant/checks/plans/${seg(id)}/move`, { body, schema: planAnswer, idempotencyKey })).plan

export interface RecordBody {
  planId?: string
  machineId?: string
  checkTypeId?: string
  performedOn: string
  outcome: CheckOutcome
  remarks: string | null
  performedBy: string
  outsideBodyPartyId: string | null
  nextDueOn: string | null
  correctsId?: string
  correctionReason?: string
  job?: Record<string, never>
  lock?: { note?: string }
}

const stepAnswer = z.object({
  result: resultSchema,
  plan: planSchema.nullable(),
  job: z.object({ id: z.string(), number: z.string() }).nullable(),
  lock: z.object({ id: z.string() }).nullable(),
  machine: z.object({ id: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean() }),
  replayed: z.boolean(),
})
export type StepAnswer = z.infer<typeof stepAnswer>

/** POST /plant/checks/results (plant.checks.manage; + plant.jobs.manage with `job`, plant.report with `lock`): ONE step. */
export const recordResult = (api: ApiClient, body: RecordBody, idempotencyKey: string) => api.post('/plant/checks/results', { body, schema: stepAnswer, idempotencyKey })

/** POST /plant/checks/results/:id/job (plant.jobs.manage): the job afterwards (one open job per result). */
export const makeJob = (api: ApiClient, id: string, idempotencyKey: string) => api.post(`/plant/checks/results/${seg(id)}/job`, { body: {}, schema: stepAnswer, idempotencyKey })

/** POST /plant/checks/results/:id/lock (plant.report): the lock afterwards (a locked machine: LOCKED_ALREADY). */
export const lockMachine = (api: ApiClient, id: string, note: string, idempotencyKey: string) =>
  api.post(`/plant/checks/results/${seg(id)}/lock`, { body: note.trim() ? { note: note.trim() } : {}, schema: stepAnswer, idempotencyKey })

// ---- the body's report and the check report PDF -----------------------------------------------------------------------------

/** What the report field takes: a PDF or an office document (DOCUMENT), or a scan as a picture (CERTIFICATE). */
export const REPORT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx,.odt'
export const REPORT_MAX_BYTES = 20 * 1024 * 1024

export const reportKindOf = (contentType: string): 'DOCUMENT' | 'CERTIFICATE' => (contentType === 'image/jpeg' || contentType === 'image/png' ? 'CERTIFICATE' : 'DOCUMENT')

const fileAnswer = z.object({ file: z.object({ id: z.string() }) })

/** One report onto a result (plant.checks.manage): announce, send the bytes, confirm. Office only, category CHECK_REPORT. */
export async function uploadReport(api: ApiClient, resultId: string, file: File, key: () => string): Promise<string> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const { file: stored, upload } = await api.post(`/plant/checks/results/${seg(resultId)}/reports`, {
    body: { kind: reportKindOf(contentType), originalName: file.name || 'report.pdf', contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: key(),
  })
  await putToStore(upload, bytes)
  await api.post(`/plant/checks/results/${seg(resultId)}/reports/${seg(stored.id)}/complete`, { body: {}, schema: fileAnswer, idempotencyKey: key() })
  return stored.id
}

/** A report's address to open in a new tab (a presigned GET; a same-origin path goes through this app's /api). */
export async function reportAddress(api: ApiClient, resultId: string, fileId: string): Promise<string> {
  const { download } = await api.get(`/plant/checks/results/${seg(resultId)}/reports/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  return download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url
}

/** GET /plant/checks/results/:id/pdf?language= (plant.view): the check report preview (a banner says so; stored nowhere). */
export const reportPreview = (api: ApiClient, resultId: string, language: 'it' | 'en', signal?: AbortSignal) => api.bytes(`/plant/checks/results/${seg(resultId)}/pdf`, { query: { language }, signal })

const keptAnswer = z.object({ document: z.object({ id: z.string(), version: z.number().int(), language: z.string(), fileId: z.string(), createdAt: z.string() }), made: z.boolean(), replayed: z.boolean() })
export type KeptReport = z.infer<typeof keptAnswer>

/** POST /plant/checks/results/:id/pdf (plant.checks.manage): kept as CHECK_REPORT v1, 2 … (the same contents: the same version back). */
export const keepReport = (api: ApiClient, resultId: string, language: 'it' | 'en', idempotencyKey: string) => api.post(`/plant/checks/results/${seg(resultId)}/pdf`, { body: { language }, schema: keptAnswer, idempotencyKey })

/** GET /files/:id (files.read): a kept file's fingerprint for its seal. */
export const readFileSeal = async (api: ApiClient, fileId: string, signal?: AbortSignal) => (await api.get(`/files/${seg(fileId)}`, { schema: z.object({ file: z.object({ id: z.string(), sha256: z.string(), originalName: z.string(), createdAt: z.string() }) }), signal })).file

// ---- the pickers --------------------------------------------------------------------------------------------------------------

export const machineChoice = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  assetNumber: z.string(),
  class: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() }),
  make: z.string().nullable(),
  modelName: z.string().nullable(),
  status: z.enum(MACHINE_STATUSES),
  locked: z.boolean(),
})
export type MachineChoice = z.infer<typeof machineChoice>

/** GET /plant/machines (plant.view): the machines in use at the site (the list leaves a retired one out: it takes no plan), at most 200. */
export const readMachineChoices = async (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  (await api.get('/plant/machines', { query: clean({ siteId, limit: 200 }), schema: z.object({ machines: z.array(machineChoice), nextCursor: z.string().nullable() }), signal })).machines

const bodyChoice = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type BodyChoice = z.infer<typeof bodyChoice>

/** GET /parties?kind=ORGANISATION&companyId= (parties.view): the outside bodies a plan or a result may name. */
export const readBodies = async (api: ApiClient, companyId: string, signal?: AbortSignal) =>
  (await api.get('/parties', { query: { kind: 'ORGANISATION', companyId, limit: 200 }, schema: z.object({ parties: z.array(bodyChoice) }), signal })).parties

const ownerChoice = z.object({ kind: z.enum(['USER', 'WORKER']), id: z.string(), name: z.string(), me: z.boolean() })
export type OwnerChoice = z.infer<typeof ownerChoice>

/**
 * GET /plant/technicians?siteId (plant.view): the office people who work maintenance at the site — a plan's owner is one of
 * them or the person typing (the API has no list of every office person with plant.view at a site: named in the notes).
 */
export const readOwners = async (api: ApiClient, siteId: string, signal?: AbortSignal) =>
  (await api.get('/plant/technicians', { query: { siteId }, schema: z.object({ technicians: z.array(ownerChoice) }), signal })).technicians.filter((person) => person.kind === 'USER')
