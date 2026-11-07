import { z } from 'zod'
import {
  FITNESS_OUTCOMES,
  HEALTH_VIEW_RECORDS,
  JUDGEMENT_STATES,
  PROPOSAL_REASONS,
  VIEW_WHATS,
  VISIT_CANCEL_REASONS,
  VISIT_STATES,
  VISIT_STATUSES,
  VISIT_TYPES,
  VOID_REASONS,
  type FitnessOutcome,
  type JudgementState,
  type VisitCancelReason,
  type VisitType,
  type VoidReason,
} from '@nexus/factory-domain/safety/health/rules'
import type { ApiClient } from '../../../lib/api/client'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Plant › Health & safety › Health surveillance (SCR-212; B-W2b-148 on B-W2b-135's API, apps/factory-api
 * modules/safety/health). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped).
 *
 *   safety.health.view     the frame (privacy words, tiles: counts only), the anonymised judgements, and THE recorded reads:
 *                          the due list (…/visits/list), the proposals, the doctor's print, a visit's or a judgement's open,
 *                          the judgements' Show, a copy's open — each writes its ProtectedView row first
 *   safety.health.manage   plan, book, move, unbook, cancel, done; record, void a judgement; its copy
 *   safety.health.plans    a plan's frequency, doctor, end-of-employment visit (plans are READ with safety.view: no person)
 *   safety.health.views    "Who looked"
 *
 * Names and health values live only in the answers of the recorded reads: the page keeps them in its state, never in the
 * address, a saved view, an export, a search index or browser storage. Every write carries the version read and its own
 * Idempotency-Key; a recorded read takes none (each opening is a view of its own). The API's English is never shown: the
 * screens say their own words from the codes (`refusal/<CODE>` → `refusal.<CODE>`).
 */

const seg = (value: string) => encodeURIComponent(value)
const codeName = z.object({ code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const userRef = z.object({ id: z.string(), name: z.string() })
const wordsIt = z.object({ en: z.string(), it: z.string() })
const person = z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable(), siteId: z.string(), site: codeName })
export type HealthPerson = z.infer<typeof person>

// ---- the frame (no person: counts only, nothing recorded) ---------------------------------------------------------------------

const tilesSchema = z.object({ overdue: z.number().int(), dueIn30: z.number().int(), beforeTask: z.number().int(), returnVisits: z.number().int(), unfitEnding: z.number().int() })
export type HealthTiles = z.infer<typeof tilesSchema>

const frameAnswer = z.object({
  today: z.string(),
  privacy: z.object({ words: wordsIt, law: z.string(), viewLog: z.boolean() }),
  liveUse: wordsIt,
  automatic: wordsIt,
  hint: wordsIt,
  tiles: tilesSchema,
  can: z.object({ manage: z.boolean(), plans: z.boolean(), views: z.boolean() }),
  law: z.string(),
})
export type HealthFrame = z.infer<typeof frameAnswer>

/** GET /safety/health (safety.health.view): the PrivacyNote's words, live use, the hint, the tiles, what the caller may do. */
export const readFrame = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/health', { query: siteId ? { siteId } : {}, schema: frameAnswer, signal })

// ---- plans per role (no person) -----------------------------------------------------------------------------------------------

export const planSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  role: ref,
  needed: z.boolean(),
  frequencyMonths: z.number().int().nullable(),
  endOfEmploymentVisit: z.boolean(),
  setOn: z.string(),
  doctor: userRef.nullable(),
  doctorSet: z.boolean(),
  risks: z.array(z.string()),
  people: z.number().int(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  canEdit: z.boolean(),
})
export type HealthPlan = z.infer<typeof planSchema>

/** GET /safety/health/plans (safety.view): one plan per role of the site; never a person. */
export const readPlans = async (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  (await api.get('/safety/health/plans', { query: siteId ? { siteId } : {}, schema: z.object({ plans: z.array(planSchema), law: z.string() }), signal })).plans

export interface PlanBody {
  readonly version: number
  readonly frequencyMonths?: number
  readonly endOfEmploymentVisit?: boolean
  readonly doctorAppointmentId?: string | null
  readonly setOn?: string
}

/** PATCH /safety/health/plans/:planId (safety.health.plans): how often, the doctor, the end-of-employment visit, the day set. */
export const editPlan = async (api: ApiClient, planId: string, body: PlanBody, idempotencyKey: string) =>
  api.request('PATCH', `/safety/health/plans/${seg(planId)}`, { body, schema: z.object({ plan: planSchema, changed: z.boolean() }), idempotencyKey })

// ---- the visits (names: every read recorded) ------------------------------------------------------------------------------------

export const visitRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  employee: person,
  role: ref.nullable(),
  type: z.enum(VISIT_TYPES),
  dueOn: z.string(),
  status: z.enum(VISIT_STATUSES),
  state: z.enum(VISIT_STATES),
  booked: z.object({ on: z.string(), place: z.string().nullable() }).nullable(),
  doneOn: z.string().nullable(),
  version: z.number().int(),
})
export type VisitRow = z.infer<typeof visitRowSchema>

export interface VisitQuery {
  readonly siteId: string | null
  readonly status: 'open' | 'done' | 'cancelled' | 'all'
  readonly type: VisitType | null
}

/** Rows per read of the due list (the API's most). */
export const VISIT_PAGE = 200

/** POST /safety/health/visits/list (safety.health.view): the due list with names — recorded LIST, one per company. */
export const listVisits = (api: ApiClient, query: VisitQuery, offset = 0) =>
  api.post('/safety/health/visits/list', {
    body: { ...(query.siteId ? { siteId: query.siteId } : {}), status: query.status, ...(query.type ? { type: query.type } : {}), offset, limit: VISIT_PAGE },
    schema: z.object({ today: z.string(), visits: z.array(visitRowSchema), more: z.boolean(), recorded: z.boolean() }),
  })

const printRow = visitRowSchema.extend({ risks: z.array(z.string()) })
export type PrintRow = z.infer<typeof printRow>

/** POST /safety/health/visits/print: the doctor's visit list (names, roles, types, risks; never a judgement) — recorded PRINT. */
export const printVisits = (api: ApiClient, siteId: string | null, visitIds: readonly string[] | null) =>
  api.post('/safety/health/visits/print', {
    body: { ...(siteId ? { siteId } : {}), ...(visitIds && visitIds.length > 0 ? { visitIds } : {}) },
    schema: z.object({ today: z.string(), visits: z.array(printRow), recorded: z.boolean(), law: z.string() }),
  })

export const proposalSchema = z.object({ employee: person, role: ref, planId: z.string(), type: z.enum(VISIT_TYPES), dueOn: z.string(), why: z.enum(PROPOSAL_REASONS), doctorSet: z.boolean() })
export type Proposal = z.infer<typeof proposalSchema>

/** POST /safety/health/visits/proposals: "Plan visits", what nobody planned yet — recorded LIST. */
export const readProposals = (api: ApiClient, siteId: string | null) =>
  api.post('/safety/health/visits/proposals', { body: siteId ? { siteId } : {}, schema: z.object({ today: z.string(), proposals: z.array(proposalSchema), recorded: z.boolean() }) })

const visitIdsOut = z.object({ visits: z.array(z.object({ id: z.string(), version: z.number().int(), status: z.enum(VISIT_STATUSES) })), replayed: z.boolean() })
export type VisitIds = z.infer<typeof visitIdsOut>['visits']

export interface PlanItem {
  readonly employeeId: string
  readonly type: VisitType
  readonly dueOn: string
  readonly roleSheetId?: string
  readonly absenceDays?: number
}

/** POST /safety/health/visits/plan (manage): the chosen items as DUE visits, all or none (refusals at `body/items/<i>/…`). */
export const planVisits = async (api: ApiClient, items: readonly PlanItem[], idempotencyKey: string) => (await api.post('/safety/health/visits/plan', { body: { items }, schema: visitIdsOut, idempotencyKey })).visits

/** POST /safety/health/visits/book (manage): "Mark 6 booked for 14 Nov". */
export const bookVisits = async (api: ApiClient, body: { visits: readonly { id: string; version: number }[]; bookedOn: string; bookedPlace?: string }, idempotencyKey: string) =>
  (await api.post('/safety/health/visits/book', { body, schema: visitIdsOut, idempotencyKey })).visits

export const visitSchema = visitRowSchema.extend({
  planId: z.string().nullable(),
  absenceDays: z.number().int().nullable(),
  booked: z.object({ on: z.string(), place: z.string().nullable(), at: z.string(), by: userRef.nullable() }).nullable(),
  cancelled: z.object({ at: z.string(), by: userRef.nullable(), reason: z.enum(VISIT_CANCEL_REASONS) }).nullable(),
  judgementId: z.string().nullable(),
  risks: z.array(z.string()),
})
export type Visit = z.infer<typeof visitSchema>

/** POST /safety/health/visits/:id/open: one visit — recorded OPEN. */
export const openVisit = async (api: ApiClient, id: string) => api.post(`/safety/health/visits/${seg(id)}/open`, { schema: z.object({ today: z.string(), visit: visitSchema, recorded: z.boolean(), law: z.string() }) })

export type VisitMove = { readonly kind: 'unbook' } | { readonly kind: 'move'; readonly dueOn: string } | { readonly kind: 'cancel'; readonly reason: VisitCancelReason } | { readonly kind: 'done'; readonly doneOn: string }

/** unbook / PATCH (move the due day) / cancel (a reason from the list) / done (manage), each at the version read. */
export const moveVisit = async (api: ApiClient, id: string, version: number, move: VisitMove, idempotencyKey: string) => {
  const path = `/safety/health/visits/${seg(id)}`
  if (move.kind === 'move') return (await api.request('PATCH', path, { body: { version, dueOn: move.dueOn }, schema: visitIdsOut, idempotencyKey })).visits
  const body = move.kind === 'cancel' ? { version, reason: move.reason } : move.kind === 'done' ? { version, doneOn: move.doneOn } : { version }
  return (await api.post(`${path}/${move.kind}`, { body, schema: visitIdsOut, idempotencyKey })).visits
}

// ---- judgements ------------------------------------------------------------------------------------------------------------------

export const judgementRowSchema = z.object({ id: z.string(), companyId: z.string(), judgedOn: z.string(), expiresOn: z.string().nullable(), state: z.enum(JUDGEMENT_STATES), fromVisit: z.boolean(), hasCopy: z.boolean(), version: z.number().int() })
export type JudgementRow = z.infer<typeof judgementRowSchema>

export type JudgementFilter = JudgementState | 'current' | 'all'

/** GET /safety/health/judgements (view): ANONYMISED — day, expiry, state, from a visit, a copy on file. Nothing recorded. */
export const listJudgements = (api: ApiClient, siteId: string | null, state: JudgementFilter, offset = 0, signal?: AbortSignal) =>
  api.get('/safety/health/judgements', { query: { ...(siteId ? { siteId } : {}), state, offset: String(offset), limit: String(VISIT_PAGE) }, schema: z.object({ today: z.string(), judgements: z.array(judgementRowSchema), more: z.boolean() }), signal })

const judgementValues = { employee: person, outcome: z.enum(FITNESS_OUTCOMES), taskLimits: z.string().nullable(), unfitUntil: z.string().nullable() }
export const shownSchema = judgementRowSchema.extend(judgementValues)
export type ShownJudgement = z.infer<typeof shownSchema>

/** The most rows one Show reads. */
export const SHOW_MOST = 100

/** POST /safety/health/judgements/show: the person and outcome of the rows asked — one OPEN view recorded per row. */
export const showJudgements = async (api: ApiClient, judgementIds: readonly string[]) =>
  (await api.post('/safety/health/judgements/show', { body: { judgementIds }, schema: z.object({ judgements: z.array(shownSchema), recorded: z.boolean() }) })).judgements

export const judgementSchema = judgementRowSchema.extend({
  ...judgementValues,
  visit: z.object({ id: z.string(), type: z.enum(VISIT_TYPES), doneOn: z.string().nullable() }).nullable(),
  doctor: userRef.nullable(),
  voided: z.object({ at: z.string(), by: userRef.nullable(), reason: z.enum(VOID_REASONS) }).nullable(),
  copies: z.array(z.object({ fileId: z.string(), name: z.string(), availableAt: z.string().nullable() })),
  recordedAt: z.string(),
})
export type Judgement = z.infer<typeof judgementSchema>

/** POST /safety/health/judgements/:id/open: one judgement — recorded OPEN. */
export const openJudgement = (api: ApiClient, id: string) =>
  api.post(`/safety/health/judgements/${seg(id)}/open`, { schema: z.object({ today: z.string(), judgement: judgementSchema, recorded: z.boolean(), law: z.string(), hint: wordsIt }) })

export interface JudgementBody {
  readonly employeeId: string
  readonly visitId?: string
  readonly outcome: FitnessOutcome
  readonly taskLimits?: string
  readonly unfitUntil?: string
  readonly judgedOn: string
  readonly expiresOn?: string
}

const judgementIdsOut = z.object({ judgement: z.object({ id: z.string(), version: z.number().int() }), visit: z.object({ id: z.string(), version: z.number().int(), status: z.enum(VISIT_STATUSES) }).nullable(), replayed: z.boolean() })

/** POST /safety/health/judgements (manage): its visit DONE in the same command; the company's doctor in force by default. */
export const recordJudgement = (api: ApiClient, body: JudgementBody, idempotencyKey: string) => api.post('/safety/health/judgements', { body, schema: judgementIdsOut, idempotencyKey })

/** POST …/:id/void (manage): kept, voided with the reason; the person's earlier judgement is in force again. */
export const voidJudgement = (api: ApiClient, id: string, body: { version: number; reason: VoidReason }, idempotencyKey: string) => api.post(`/safety/health/judgements/${seg(id)}/void`, { body, schema: judgementIdsOut, idempotencyKey })

const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

/** The doctor's copy onto a judgement (manage; office only, module-owned): announce, send, confirm. */
export async function uploadCopy(api: ApiClient, judgementId: string, file: Blob, name: string, idempotencyKey: string): Promise<string> {
  const bytes = await file.arrayBuffer()
  const path = `/safety/health/judgements/${seg(judgementId)}/copy`
  const { file: stored, upload } = await api.post(path, {
    body: { originalName: name, contentType: file.type || 'application/pdf', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }).passthrough(), upload: presigned }),
    idempotencyKey,
  })
  await putToStore(upload, bytes)
  await api.post(`${path}/${seg(stored.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }).passthrough() }), idempotencyKey: `${idempotencyKey}.complete` })
  return stored.id
}

/** The doctor's copy to read (a COPY view recorded first, then a presigned GET read once into the page). */
export async function copyBytes(api: ApiClient, judgementId: string, fileId: string): Promise<Uint8Array> {
  const answer = await api.post(`/safety/health/judgements/${seg(judgementId)}/copy/${seg(fileId)}/open`, { schema: z.object({ download: presigned }) })
  return readFromStore(answer.download)
}

// ---- who looked (safety.health.views) ---------------------------------------------------------------------------------------------

export const viewSchema = z.object({ id: z.string(), viewer: userRef, viewedAt: z.string(), recordType: z.enum(HEALTH_VIEW_RECORDS), recordId: z.string().nullable(), what: z.enum(VIEW_WHATS), employee: z.object({ id: z.string(), name: z.string() }).nullable() })
export type HealthView = z.infer<typeof viewSchema>
const viewsAnswer = z.object({ views: z.array(viewSchema), fitnessChecks: z.array(z.object({ viewer: userRef, at: z.string() })), law: z.string() })
export type ViewsAnswer = z.infer<typeof viewsAnswer>

/** Whose views: one record, or a company's lists (the due list, its print, the proposals). */
export type ViewsOf = { readonly recordType: 'HEALTH_VISIT' | 'FITNESS_JUDGEMENT'; readonly recordId: string } | { readonly companyId: string; readonly lists: true }

/** The rows "Who looked" reads at once. */
export const VIEWS_MOST = 50

/** GET /safety/health/views (safety.health.views): viewer · time · what, newest first. Reading the log records nothing. */
export const readViews = (api: ApiClient, of: ViewsOf, signal?: AbortSignal) =>
  api.get('/safety/health/views', { query: 'recordId' in of ? { recordType: of.recordType, recordId: of.recordId, limit: String(VIEWS_MOST) } : { companyId: of.companyId, lists: 'true', limit: String(VIEWS_MOST) }, schema: viewsAnswer, signal })

// ---- pickers (each read may be closed to the person: the dialog says so) -----------------------------------------------------------

const peopleAnswer = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable(), site: ref })), complete: z.boolean() })
export type PickedPerson = z.infer<typeof peopleAnswer>['people'][number]

/** GET /safety/organisation/people?companyId (safety.organisation.manage: HR): ACTIVE people of the company, names only. */
export const readPeople = (api: ApiClient, companyId: string, q: string | null, signal?: AbortSignal) => api.get('/safety/organisation/people', { query: { companyId, ...(q ? { q } : {}) }, schema: peopleAnswer, signal })

const organisationAnswer = z.object({
  appointments: z.array(z.object({ id: z.string(), companyId: z.string(), role: z.string(), appointee: z.object({ name: z.string() }).passthrough(), inForce: z.boolean(), ended: z.boolean(), fromDate: z.string(), untilDate: z.string().nullable() }).passthrough()),
})
export interface DoctorChoice {
  readonly id: string
  readonly name: string
  readonly fromDate: string
  readonly untilDate: string | null
  readonly inForce: boolean
}

/** GET /safety/organisation?companyId (safety.view): the company's occupational doctors (appointments DOCTOR, not ended). */
export const readDoctors = async (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<DoctorChoice[]> =>
  (await api.get('/safety/organisation', { query: { companyId }, schema: organisationAnswer, signal })).appointments
    .filter((row) => row.role === 'DOCTOR' && row.companyId === companyId && !row.ended)
    .map((row) => ({ id: row.id, name: row.appointee.name, fromDate: row.fromDate, untilDate: row.untilDate, inForce: row.inForce }))

export const ALL_VISIT_TYPES = VISIT_TYPES
export const ALL_OUTCOMES = FITNESS_OUTCOMES
export const ALL_CANCEL_REASONS = VISIT_CANCEL_REASONS
export const ALL_VOID_REASONS = VOID_REASONS
export const ALL_JUDGEMENT_STATES = JUDGEMENT_STATES
