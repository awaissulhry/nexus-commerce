import { z } from 'zod'
import { JOB_TYPES, PRIORITIES, type JobType, type Priority } from '@nexus/factory-domain/plant/rules'
import {
  ACTION_LINKS,
  ACTION_STATUSES,
  BODY_PARTS,
  BODY_SIDES,
  FILING_STATES,
  FILING_STATUSES,
  FILING_TYPES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INJURY_NATURES,
  INVOLVEMENTS,
  REPORTED_VIA,
  type BodyPart,
  type BodySide,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentStatus,
  type InjuryNature,
  type Involvement,
} from '@nexus/factory-domain/safety/incidents/rules'
import type { ApiClient } from '../../../lib/api/client'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Plant › Health & safety › Incidents (SCR-210; B-W2b-149 on B-W2b-125's API, apps/factory-api
 * modules/safety/incidents). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped).
 *
 *   safety.incidents.view     the anonymised list, the counts (tiles, the critical banner, the band's chip), the record, the rule
 *   safety.incidents.report   an office report (with people: written, never read back)
 *   safety.incidents.manage   seen, edit, close / reopen / cancel, photos, the actions (made into a job, a measure, a session)
 *   safety.incidents.people   THE protected reads (…/people/open, POST /safety/incidents/people, …/filings/open: each writes
 *                             its ProtectedView row first) and the INAIL filings with INAIL's receipt
 *
 * The people and the filing's type live only in the answers of the protected reads: the page keeps them in its state, never in
 * the address, a saved view, an export or a cache. Every write carries the version read and its own Idempotency-Key. The API's
 * English messages are never shown: the screens say their own words from the codes (`refusal/<CODE>` → `refusal.<CODE>`).
 */

const seg = (value: string) => encodeURIComponent(value)
const codeName = z.object({ code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const countdownSchema = z.object({ dueAt: z.string(), minutesLeft: z.number().int(), hoursLeft: z.number().int(), under24h: z.boolean(), late: z.boolean() })
export type Countdown = z.infer<typeof countdownSchema>

const where = {
  area: ref.nullable(),
  station: ref.nullable(),
  machine: z.object({ id: z.string(), assetNumber: z.string() }).nullable(),
  place: z.string().nullable(),
}

// ---- the list --------------------------------------------------------------------------------------------------------------

export const listItemSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  occurredAt: z.string(),
  reportedAt: z.string(),
  reportedVia: z.enum(REPORTED_VIA),
  anonymous: z.boolean(),
  ...where,
  severity: z.enum(INCIDENT_SEVERITIES).nullable(),
  status: z.enum(INCIDENT_STATUSES),
  seen: z.boolean(),
  actionsOpen: z.number().int(),
  actionsOverdue: z.number().int(),
  people: z.object({ count: z.number().int(), injured: z.number().int() }),
  inail: z.object({ open: z.number().int(), state: z.enum(FILING_STATES).nullable(), countdown: countdownSchema.nullable() }),
  photos: z.number().int(),
  version: z.number().int(),
})
export type IncidentRow = z.infer<typeof listItemSchema>

const listAnswer = z.object({ now: z.string(), incidents: z.array(listItemSchema), nextCursor: z.string().nullable(), canReport: z.boolean() })
export type ListAnswer = z.infer<typeof listAnswer>

export interface ListQuery {
  readonly siteId: string | null
  readonly rows: 'INJURY' | 'NEAR_MISS' | 'HAZARD' | 'INAIL_DUE' | null
  readonly status: IncidentStatus | 'ALL' | null
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
}

/** GET /safety/incidents (safety.incidents.view): the anonymised list, newest first, 50 a page with the cursor. */
export const readIncidents = (api: ApiClient, query: ListQuery, cursor: string | null, signal?: AbortSignal) =>
  api.get('/safety/incidents', {
    query: {
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.rows ? { rows: query.rows } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    },
    schema: listAnswer,
    signal,
  })

const banner = z.object({ incidentId: z.string(), number: z.string(), countdown: countdownSchema })
const countsAnswer = z.object({
  now: z.string(),
  tiles: z.object({ openIncidents: z.number().int(), inailOpen: z.number().int(), nearMissesThisMonth: z.number().int(), hazardsOpen: z.number().int(), actionsOverdue: z.number().int() }),
  deadline: banner.extend({ more: z.number().int() }).nullable(),
  next: banner.nullable(),
  law: z.string(),
})
export type CountsAnswer = z.infer<typeof countsAnswer>

/** GET /safety/incidents/counts: the tiles, the critical banner (a deadline under 24 h or late) and the band's chip. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/incidents/counts', { query: siteId ? { siteId } : {}, schema: countsAnswer, signal })

// ---- the record ------------------------------------------------------------------------------------------------------------

const ruleSchema = z.object({ law: z.string(), statisticalFromDays: z.number().int(), insuranceAboveDays: z.number().int(), hoursAfterCertificate: z.number().int(), words: z.object({ en: z.array(z.string()), it: z.array(z.string()) }) })
export type InailRule = z.infer<typeof ruleSchema>

export const deadlineSchema = z.object({ id: z.string(), state: z.enum(FILING_STATES), status: z.enum(FILING_STATUSES), countdown: countdownSchema.nullable(), version: z.number().int() })
export type FilingDeadline = z.infer<typeof deadlineSchema>

export const actionSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  dueOn: z.string().nullable(),
  status: z.enum(ACTION_STATUSES),
  overdue: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  madeInto: z.enum(ACTION_LINKS).nullable(),
  record: z.object({ type: z.enum(['MaintenanceJob', 'RiskMeasure', 'TrainingSession']), id: z.string(), label: z.string(), status: z.string() }).nullable(),
  version: z.number().int(),
})
export type IncidentAction = z.infer<typeof actionSchema>

const by = z.object({ at: z.string(), by: z.string().nullable() })
const photoSchema = z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: z.string().nullable() })
export type IncidentPhoto = z.infer<typeof photoSchema>

export const incidentSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  occurredAt: z.string(),
  reportedAt: z.string(),
  what: z.string(),
  ...where,
  immediateAction: z.string().nullable(),
  maintenanceRequest: z.object({ id: z.string(), status: z.string(), unsafe: z.boolean() }).nullable(),
  severity: z.enum(INCIDENT_SEVERITIES).nullable(),
  status: z.enum(INCIDENT_STATUSES),
  reportedVia: z.enum(REPORTED_VIA),
  reporter: z.object({ kind: z.enum(['ANONYMOUS', 'WORKER', 'USER', 'SYSTEM']), name: z.string().nullable(), hidden: z.boolean(), device: z.object({ id: z.string(), name: z.string() }).nullable() }),
  seen: by.nullable(),
  closed: by.nullable(),
  cancelled: by.extend({ reason: z.string().nullable() }).nullable(),
  people: z.object({ count: z.number().int(), injured: z.number().int(), canOpen: z.boolean() }),
  actions: z.array(actionSchema),
  inail: z.object({ deadlines: z.array(deadlineSchema), canOpen: z.boolean(), law: z.string(), rule: ruleSchema }),
  photos: z.array(photoSchema),
  version: z.number().int(),
  canManage: z.boolean(),
  canPeople: z.boolean(),
  canClose: z.boolean(),
  law: z.object({ incident: z.string(), people: z.string() }),
})
export type IncidentRecord = z.infer<typeof incidentSchema>
const recordAnswer = z.object({ now: z.string(), incident: incidentSchema })
export type RecordAnswer = z.infer<typeof recordAnswer>

/** GET /safety/incidents/:id (safety.incidents.view): the record, people as counts, the deadlines without their type. */
export const readIncident = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/incidents/${seg(id)}`, { schema: recordAnswer, signal })

// ---- the protected reads (each writes its ProtectedView row first) ----------------------------------------------------------

export const personSchema = z.object({
  id: z.string(),
  involvement: z.enum(INVOLVEMENTS),
  employee: z.object({ id: z.string(), name: z.string() }).nullable(),
  outsideName: z.string().nullable(),
  bodyParts: z.array(z.enum(BODY_PARTS)),
  bodySide: z.enum(BODY_SIDES).nullable(),
  nature: z.enum(INJURY_NATURES).nullable(),
  firstAidGiven: z.boolean(),
  sentToHospital: z.boolean(),
  filings: z.number().int(),
  version: z.number().int(),
})
export type IncidentPerson = z.infer<typeof personSchema>

/** POST …/:id/people/open (safety.incidents.people): ONE view recorded per person, then the values. */
export const openPeople = async (api: ApiClient, id: string) =>
  (await api.post(`/safety/incidents/${seg(id)}/people/open`, { schema: z.object({ incident: z.object({ id: z.string(), number: z.string() }), people: z.array(personSchema), recorded: z.boolean(), law: z.string() }) })).people

/** POST /safety/incidents/people (safety.incidents.people): "Show people" of the list's incidents (≤ 100), one LIST view recorded. */
export const showPeople = async (api: ApiClient, incidentIds: readonly string[]) =>
  (await api.post('/safety/incidents/people', { body: { incidentIds }, schema: z.object({ incidents: z.array(z.object({ id: z.string(), people: z.array(personSchema) })), recorded: z.boolean() }) })).incidents

export const filingSchema = z.object({
  id: z.string(),
  personId: z.string(),
  person: z.object({ employeeId: z.string().nullable(), name: z.string() }),
  type: z.enum(FILING_TYPES),
  status: z.enum(FILING_STATUSES),
  state: z.enum(FILING_STATES),
  expectedAbsenceDays: z.number().int().nullable(),
  actualAbsenceDays: z.number().int().nullable(),
  certificateReference: z.string().nullable(),
  certificateReceivedAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  countdown: countdownSchema.nullable(),
  filedAt: z.string().nullable(),
  filedBy: z.string().nullable(),
  protocolNumber: z.string().nullable(),
  notNeededAt: z.string().nullable(),
  notNeededBy: z.string().nullable(),
  receipt: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  version: z.number().int(),
})
export type InailFiling = z.infer<typeof filingSchema>

/** POST …/:id/filings/open (safety.incidents.people): ONE view recorded per filing, then the type, absence, certificate… */
export const openFilings = async (api: ApiClient, id: string) =>
  api.post(`/safety/incidents/${seg(id)}/filings/open`, {
    schema: z.object({ incident: z.object({ id: z.string(), number: z.string(), occurredAt: z.string() }), now: z.string(), filings: z.array(filingSchema), recorded: z.boolean(), rule: ruleSchema }),
  })

// ---- writes --------------------------------------------------------------------------------------------------------------

export interface PersonBody {
  readonly involvement: Involvement
  readonly employeeId?: string
  readonly outsideName?: string
  readonly bodyParts?: readonly BodyPart[]
  readonly bodySide?: BodySide | null
  readonly nature?: InjuryNature | null
  readonly firstAidGiven?: boolean
  readonly sentToHospital?: boolean
}

export interface ReportBody {
  readonly companyId: string
  readonly siteId: string
  readonly kind: IncidentKind
  readonly occurredAt: string
  readonly what: string
  readonly areaId?: string
  readonly stationId?: string
  readonly machineId?: string
  readonly place?: string
  readonly immediateAction?: string
  readonly people?: readonly PersonBody[]
}

const reportOut = z.object({ incident: z.object({ id: z.string(), number: z.string(), kind: z.enum(INCIDENT_KINDS), status: z.literal('OPEN'), anonymous: z.boolean(), version: z.number().int() }), replayed: z.boolean() })

/** POST /safety/incidents (safety.incidents.report): the office report; it always carries the reporter's name. */
export const reportIncident = async (api: ApiClient, body: ReportBody, idempotencyKey: string) => (await api.post('/safety/incidents', { body, schema: reportOut, idempotencyKey })).incident

const changedOut = z.object({ incident: z.object({ id: z.string(), version: z.number().int(), status: z.enum(INCIDENT_STATUSES).optional() }), replayed: z.boolean() })

export interface EditBody {
  readonly version: number
  readonly kind?: IncidentKind
  readonly occurredAt?: string
  readonly what?: string
  readonly place?: string | null
  readonly immediateAction?: string | null
  readonly severity?: IncidentSeverity | null
}

/** PATCH /safety/incidents/:id (manage, while OPEN). */
export const editIncident = async (api: ApiClient, id: string, body: EditBody, idempotencyKey: string) => (await api.request('PATCH', `/safety/incidents/${seg(id)}`, { body, schema: changedOut, idempotencyKey })).incident

/** POST …/:id/seen (manage): "Seen by safety", once (a second call answers the first). */
export const markSeen = async (api: ApiClient, id: string, idempotencyKey: string) =>
  (await api.post(`/safety/incidents/${seg(id)}/seen`, { schema: z.object({ incident: z.object({ id: z.string(), version: z.number().int(), seenAt: z.string(), first: z.boolean() }), replayed: z.boolean() }), idempotencyKey })).incident

/** POST …/:id/close | reopen (manage, at the version read). */
export const moveIncident = async (api: ApiClient, id: string, move: 'close' | 'reopen', version: number, idempotencyKey: string) => (await api.post(`/safety/incidents/${seg(id)}/${move}`, { body: { version }, schema: changedOut, idempotencyKey })).incident

/** POST …/:id/cancel (manage) with the reason; held as close is. */
export const cancelIncident = async (api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string) => (await api.post(`/safety/incidents/${seg(id)}/cancel`, { body, schema: changedOut, idempotencyKey })).incident

// ---- actions -------------------------------------------------------------------------------------------------------------

export type MakeBody =
  | { readonly into: 'MAINTENANCE_JOB'; readonly machineId?: string; readonly type?: JobType; readonly priority?: Priority; readonly problem?: string }
  | { readonly into: 'RISK_MEASURE'; readonly assessmentId?: string; readonly risk?: string }

export const MAKE_JOB_TYPES = JOB_TYPES
export const MAKE_PRIORITIES = PRIORITIES

const actionWriteOut = z.object({ action: z.object({ id: z.string(), version: z.number().int(), madeInto: z.enum(ACTION_LINKS).nullable().optional(), recordId: z.string().nullable().optional(), status: z.enum(ACTION_STATUSES).optional() }), replayed: z.boolean() })
const actionPath = (incidentId: string, actionId: string) => `/safety/incidents/${seg(incidentId)}/actions/${seg(actionId)}`

/** POST …/:id/actions (manage): a plain action, or one made into its record in the same step. */
export const addAction = async (api: ApiClient, incidentId: string, body: { title: string; ownerId?: string; dueOn?: string; make?: MakeBody }, idempotencyKey: string) =>
  (await api.post(`/safety/incidents/${seg(incidentId)}/actions`, { body, schema: actionWriteOut, idempotencyKey })).action

/** POST …/actions/:actionId/make (manage): a plain action made into its record (set once). */
export const makeAction = async (api: ApiClient, incidentId: string, actionId: string, body: { version: number; make: MakeBody }, idempotencyKey: string) =>
  (await api.post(`${actionPath(incidentId, actionId)}/make`, { body, schema: actionWriteOut, idempotencyKey })).action

/** PATCH …/actions/:actionId (manage, while OPEN): title, owner, due day, evidence note. */
export const editAction = async (api: ApiClient, incidentId: string, actionId: string, body: { version: number; title?: string; ownerId?: string | null; dueOn?: string | null; evidenceNote?: string | null }, idempotencyKey: string) =>
  (await api.request('PATCH', actionPath(incidentId, actionId), { body, schema: actionWriteOut, idempotencyKey })).action

/** POST …/actions/:actionId/done (manage) with an optional evidence note. */
export const actionDone = async (api: ApiClient, incidentId: string, actionId: string, body: { version: number; evidenceNote?: string }, idempotencyKey: string) =>
  (await api.post(`${actionPath(incidentId, actionId)}/done`, { body, schema: actionWriteOut, idempotencyKey })).action

/** POST …/actions/:actionId/cancel (manage) with the reason. */
export const actionCancel = async (api: ApiClient, incidentId: string, actionId: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  (await api.post(`${actionPath(incidentId, actionId)}/cancel`, { body, schema: actionWriteOut, idempotencyKey })).action

// ---- INAIL filings (safety.incidents.people) --------------------------------------------------------------------------------

const filingStateOut = z.object({ id: z.string(), version: z.number().int(), status: z.enum(FILING_STATUSES), dueAt: z.string().nullable() })
export type FilingStateOut = z.infer<typeof filingStateOut>
const filingPath = (incidentId: string, filingId: string) => `/safety/incidents/${seg(incidentId)}/filings/${seg(filingId)}`

/** POST …/:id/filings: the absence decides the filing (≥ 1 day statistical, > 3 insurance); a certificate starts the 48 h clock. */
export const addFiling = async (api: ApiClient, incidentId: string, body: { incidentPersonId: string; expectedAbsenceDays: number; certificateReference?: string; certificateReceivedAt?: string }, idempotencyKey: string) =>
  (await api.post(`/safety/incidents/${seg(incidentId)}/filings`, { body, schema: z.object({ filings: z.array(filingStateOut), replayed: z.boolean() }), idempotencyKey })).filings

/** PATCH …/filings/:filingId: the absence, the certificate (→ DUE, due 48 h after it); a statistical one past 3 days adds the insurance one. */
export const editFiling = async (
  api: ApiClient,
  incidentId: string,
  filingId: string,
  body: { version: number; expectedAbsenceDays?: number | null; actualAbsenceDays?: number | null; certificateReference?: string | null; certificateReceivedAt?: string },
  idempotencyKey: string,
) => api.request('PATCH', filingPath(incidentId, filingId), { body, schema: z.object({ filing: filingStateOut, added: z.array(filingStateOut), replayed: z.boolean() }), idempotencyKey })

/** POST …/filings/:filingId/file: filed on the INAIL portal at, with INAIL's protocol number. */
export const fileFiling = async (api: ApiClient, incidentId: string, filingId: string, body: { version: number; filedAt: string; protocolNumber: string }, idempotencyKey: string) =>
  (await api.post(`${filingPath(incidentId, filingId)}/file`, { body, schema: z.object({ filing: filingStateOut, replayed: z.boolean() }), idempotencyKey })).filing

/** POST …/filings/:filingId/not-needed | needed. */
export const setFilingNeeded = async (api: ApiClient, incidentId: string, filingId: string, needed: boolean, version: number, idempotencyKey: string) =>
  (await api.post(`${filingPath(incidentId, filingId)}/${needed ? 'needed' : 'not-needed'}`, { body: { version }, schema: z.object({ filing: filingStateOut, replayed: z.boolean() }), idempotencyKey })).filing

// ---- files ---------------------------------------------------------------------------------------------------------------

const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const uploadOut = z.object({ file: z.object({ id: z.string() }).passthrough(), upload: presigned })
const downloadOut = z.object({ download: presigned })

/** A presigned GET as an address the browser opens (a same-origin path goes through this app's /api). */
const addressOf = (url: string): string => (url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url)

async function sendFile(api: ApiClient, path: string, file: Blob, name: string, idempotencyKey: string): Promise<string> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'image/jpeg'
  const { file: stored, upload } = await api.post(path, { body: { originalName: name, contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }, schema: uploadOut, idempotencyKey })
  await putToStore(upload, bytes)
  await api.post(`${path}/${seg(stored.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }).passthrough() }), idempotencyKey: `${idempotencyKey}.complete` })
  return stored.id
}

/** A photo onto the incident (office only; manage, or the office reporter for their own report): announce, send, confirm. */
export const uploadPhoto = (api: ApiClient, incidentId: string, photo: Blob, name: string, idempotencyKey: string) => sendFile(api, `/safety/incidents/${seg(incidentId)}/photos`, photo, name, idempotencyKey)

/** A photo's address (a presigned GET of 60 seconds; safety.incidents.view). */
export const photoAddress = async (api: ApiClient, incidentId: string, fileId: string) => addressOf((await api.get(`/safety/incidents/${seg(incidentId)}/photos/${seg(fileId)}/download`, { schema: downloadOut })).download.url)

/** INAIL's receipt onto a filing (people; a PDF or a picture). */
export const uploadReceipt = (api: ApiClient, incidentId: string, filingId: string, file: File, idempotencyKey: string) => sendFile(api, `${filingPath(incidentId, filingId)}/receipt`, file, file.name || 'receipt.pdf', idempotencyKey)

/** INAIL's receipt to open (a COPY view recorded first, then a presigned GET). */
export const receiptAddress = async (api: ApiClient, incidentId: string, filingId: string, fileId: string) => addressOf((await api.post(`${filingPath(incidentId, filingId)}/receipt/${seg(fileId)}/open`, { schema: downloadOut })).download.url)

// ---- pickers (each read may be closed to the person: the dialog says so and offers the words) ------------------------------

const placesAnswer = z.object({ sites: z.array(z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), stations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() }).passthrough()) }).passthrough()) })
export type PlantPlaces = z.infer<typeof placesAnswer>

/** GET /plant/places (plant.view): the stations of each site. */
export const readPlaces = (api: ApiClient, signal?: AbortSignal) => api.get('/plant/places', { schema: placesAnswer, signal })

const machinesAnswer = z.object({ machines: z.array(z.object({ id: z.string(), assetNumber: z.string() })) })
export type PickedMachine = z.infer<typeof machinesAnswer>['machines'][number]

/** GET /plant/machines?siteId (plant.view): the site's machines by asset number (not retired). */
export const readMachines = async (api: ApiClient, siteId: string, signal?: AbortSignal) => (await api.get('/plant/machines', { query: { siteId, limit: 200 }, schema: machinesAnswer, signal })).machines

const peopleAnswer = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable(), site: ref })), complete: z.boolean() })
export type PickedPerson = z.infer<typeof peopleAnswer>['people'][number]

/** GET /safety/organisation/people?companyId (safety.organisation.manage): ACTIVE people of the company, names only. */
export const readPeople = async (api: ApiClient, companyId: string, q: string | null, signal?: AbortSignal) => api.get('/safety/organisation/people', { query: { companyId, ...(q ? { q } : {}) }, schema: peopleAnswer, signal })

export const ALL_BODY_PARTS = BODY_PARTS
export const ALL_BODY_SIDES = BODY_SIDES
export const ALL_NATURES = INJURY_NATURES
