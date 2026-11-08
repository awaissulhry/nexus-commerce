import { z } from 'zod'
import { ACTION_KINDS, ACTION_STATUSES, CAPA_PRIORITIES, CAPA_STATUSES, CAPA_TYPES, CAPA_VIEWS, ESCALATION_REASONS, SOURCE_TYPES, type ActionKind, type CapaPriority, type CapaType, type CapaView, type SourceType } from '@nexus/factory-domain/quality/capa/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, downloadLink, listFiles, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Quality › Problems › Corrective actions (SCR-146; B-W2b-108's routes, `apps/factory-api` modules/quality/capa):
 * the list and its tiles, the people who may own or be given work on a CAPA, the record and its writes, the actions, the
 * 8D report (preview bytes, a version kept), the sources a new CAPA may start from (the NCR and complaint lists), the
 * customers an 8D is written for, an action's evidence files (the generic files routes, record type "CapaAction") and the
 * complaint's "Share with the customer" of the 8D (B-W2b-192). Each answer is checked with zod; the API's English words
 * (`closing.checks[].words`, refusals) are never shown: the screens say their own from codes.
 */

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

export { newIdempotencyKey }
export type { ActionKind, CapaPriority, CapaType, CapaView, SourceType }
export type CapaStatus = (typeof CAPA_STATUSES)[number]
export type ActionStatus = (typeof ACTION_STATUSES)[number]

const person = z.object({ id: z.string(), name: z.string() })
export type Person = z.infer<typeof person>
const customer = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const capaRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  type: z.enum(CAPA_TYPES),
  title: z.string(),
  status: z.enum(CAPA_STATUSES),
  priority: z.enum(CAPA_PRIORITIES),
  customer: customer.nullable(),
  ownerId: z.string(),
  team: z.array(z.object({ userId: z.string(), role: z.string() })),
  dueOn: z.string(),
  nextDue: z.string().nullable(),
  overdue: z.boolean(),
  sources: z.object({ count: z.number(), items: z.array(z.object({ id: z.string(), recordType: z.string(), recordId: z.string(), label: z.string().nullable() })) }),
  actions: z.object({ count: z.number(), open: z.number(), overdue: z.number(), done: z.number() }),
  ageDays: z.number(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CapaRow = z.infer<typeof capaRowSchema>

export const actionSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(ACTION_KINDS),
  description: z.string(),
  ownerId: z.string(),
  dueOn: z.string(),
  status: z.enum(ACTION_STATUSES),
  overdue: z.boolean(),
  remindersSent: z.number(),
  lastRemindedAt: z.string().nullable(),
  escalateToId: z.string().nullable(),
  escalatedAt: z.string().nullable(),
  doneAt: z.string().nullable(),
  doneById: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  files: z.number(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type CapaAction = z.infer<typeof actionSchema>

const reportVersion = z.object({ id: z.string(), version: z.number(), language: z.string(), number: z.string().nullable(), fileId: z.string(), createdAt: z.string(), createdById: z.string().nullable() })
export type ReportVersion = z.infer<typeof reportVersion>

export const recordSchema = z.object({
  capa: capaRowSchema.extend({
    problem: z.object({ what: z.string().nullable(), where: z.string().nullable(), when: z.string().nullable(), howMany: z.string().nullable() }),
    closedById: z.string().nullable(),
    closeNote: z.string().nullable(),
    cancelReason: z.string().nullable(),
    createdById: z.string().nullable(),
  }),
  sources: z.array(
    z.object({
      id: z.string(),
      recordType: z.enum(SOURCE_TYPES),
      recordId: z.string(),
      note: z.string().nullable(),
      createdAt: z.string(),
      createdById: z.string().nullable(),
      record: z.object({ number: z.string(), title: z.string().nullable(), state: z.string(), severity: z.string().nullable(), category: z.string().nullable(), siteId: z.string().nullable(), namesThisCapa: z.boolean() }).nullable(),
    }),
  ),
  containment: z.array(
    z.object({
      ncrId: z.string(),
      number: z.string(),
      stage: z.string(),
      activeHolds: z.number(),
      actions: z.array(z.object({ seq: z.number(), kind: z.string(), description: z.string().nullable(), status: z.string(), dueAt: z.string().nullable(), doneAt: z.string().nullable() })),
    }),
  ),
  causes: z.array(z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), process: z.string() })),
  actions: z.array(actionSchema),
  documents: z.array(reportVersion),
  next: z.object({ stage: z.enum(CAPA_STATUSES).nullable() }),
  closing: z.object({ checks: z.array(z.object({ key: z.enum(['LAST_STAGE', 'ACTION_DONE', 'NO_OPEN_ACTION']), ok: z.boolean(), words: z.string() })), ready: z.boolean() }),
  may: z.object({ manage: z.boolean(), edit: z.boolean(), close: z.boolean(), report: z.boolean() }),
  people: z.array(person),
})
export type CapaRecord = z.infer<typeof recordSchema>
export type CapaSource = CapaRecord['sources'][number]
const one = z.object({ record: recordSchema })

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface CapaQuery {
  view: CapaView
  type: CapaType | null
  priority: CapaPriority | null
  q: string
}

const listAnswer = z.object({ capas: z.array(capaRowSchema), nextCursor: z.string().nullable(), people: z.array(person), asOf: z.string() })
export type CapaPage = z.infer<typeof listAnswer>

/** GET /quality/capa: one page of the list (200 at most; `nextCursor` names the next). */
export const listCapas = (api: ApiClient, query: CapaQuery, cursor: string | null, signal?: AbortSignal): Promise<CapaPage> =>
  api.get('/quality/capa', { query: clean({ view: (CAPA_VIEWS as readonly string[]).includes(query.view) ? query.view : 'open', type: query.type, priority: query.priority, q: query.q.trim().slice(0, 100), cursor, limit: 200 }), schema: listAnswer, signal })

const countsAnswer = z.object({ tiles: z.object({ open: z.number(), actionsOverdue: z.number(), mine: z.number() }), asOf: z.string() })
export type CapaCounts = z.infer<typeof countsAnswer>['tiles']
export const capaCounts = (api: ApiClient, signal?: AbortSignal): Promise<CapaCounts> => api.get('/quality/capa/counts', { schema: countsAnswer, signal }).then((answer) => answer.tiles)

const peopleAnswer = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), manages: z.boolean(), remindable: z.boolean(), me: z.boolean() })) })
export type CapaPerson = z.infer<typeof peopleAnswer>['people'][number]
/** The office people who see CAPAs of this company (and customer): who may own one, who may be given its tasks. */
export const capaPeople = (api: ApiClient, companyId: string, customerId: string | null, signal?: AbortSignal): Promise<CapaPerson[]> =>
  api.get('/quality/capa/people', { query: clean({ companyId, customerId }), schema: peopleAnswer, signal }).then((answer) => answer.people)

export const getCapa = (api: ApiClient, capaId: string, signal?: AbortSignal): Promise<CapaRecord> => api.get(`/quality/capa/${seg(capaId)}`, { schema: one, signal }).then((answer) => answer.record)

// ---- the CAPA's writes ---------------------------------------------------------------------------------------------------

export interface OpenBody {
  companyId?: string
  type: CapaType
  title: string
  ownerId?: string
  team?: { userId: string; role: string }[]
  dueOn: string
  priority?: CapaPriority
  customerId?: string | null
  problemWhat?: string | null
  sources?: { recordType: SourceType; recordId: string }[]
}
export const openCapa = (api: ApiClient, body: OpenBody, idempotencyKey: string): Promise<CapaRecord> => api.post('/quality/capa', { body, schema: one, idempotencyKey }).then((answer) => answer.record)

export interface EditBody {
  version: number
  title?: string
  ownerId?: string
  team?: { userId: string; role: string }[]
  dueOn?: string
  priority?: CapaPriority
  customerId?: string | null
  problemWhat?: string | null
  problemWhere?: string | null
  problemWhen?: string | null
  problemHowMany?: string | null
}
export const editCapa = (api: ApiClient, capaId: string, body: EditBody): Promise<CapaRecord> =>
  api.request('PATCH', `/quality/capa/${seg(capaId)}`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const moveCapa = (api: ApiClient, capaId: string, body: { version: number; to: CapaStatus }): Promise<CapaRecord> =>
  api.post(`/quality/capa/${seg(capaId)}/stage`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const closeCapa = (api: ApiClient, capaId: string, body: { version: number; note: string }, idempotencyKey: string): Promise<CapaRecord> =>
  api.post(`/quality/capa/${seg(capaId)}/close`, { body, schema: one, idempotencyKey }).then((answer) => answer.record)
export const cancelCapa = (api: ApiClient, capaId: string, body: { version: number; reason: string }, idempotencyKey: string): Promise<CapaRecord> =>
  api.post(`/quality/capa/${seg(capaId)}/cancel`, { body, schema: one, idempotencyKey }).then((answer) => answer.record)
export const removeSource = (api: ApiClient, capaId: string, sourceId: string, version: number): Promise<CapaRecord> =>
  api.request('DELETE', `/quality/capa/${seg(capaId)}/sources/${seg(sourceId)}`, { query: { version }, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

// ---- actions ---------------------------------------------------------------------------------------------------------------

export interface ActionBody {
  kind: ActionKind
  description: string
  ownerId?: string
  dueOn: string
  escalateToId?: string | null
}
export const addAction = (api: ApiClient, capaId: string, body: ActionBody, idempotencyKey: string) =>
  api.post(`/quality/capa/${seg(capaId)}/actions`, { body, schema: z.object({ record: recordSchema, actionId: z.string() }), idempotencyKey })
export interface ActionChange {
  kind?: ActionKind
  description?: string
  ownerId?: string
  dueOn?: string
  escalateToId?: string | null
}
export const editAction = (api: ApiClient, capaId: string, actionId: string, body: ActionChange & { version: number }): Promise<CapaRecord> =>
  api.request('PATCH', `/quality/capa/${seg(capaId)}/actions/${seg(actionId)}`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const doneAction = (api: ApiClient, capaId: string, actionId: string, body: { version: number; evidenceNote?: string | null }, idempotencyKey: string): Promise<CapaRecord> =>
  api.post(`/quality/capa/${seg(capaId)}/actions/${seg(actionId)}/done`, { body, schema: one, idempotencyKey }).then((answer) => answer.record)
export const cancelAction = (api: ApiClient, capaId: string, actionId: string, body: { version: number; reason: string }, idempotencyKey: string): Promise<CapaRecord> =>
  api.post(`/quality/capa/${seg(capaId)}/actions/${seg(actionId)}/cancel`, { body, schema: one, idempotencyKey }).then((answer) => answer.record)
export const remindAction = (api: ApiClient, capaId: string, actionId: string, version: number) =>
  api.post(`/quality/capa/${seg(capaId)}/actions/${seg(actionId)}/remind`, {
    body: { version },
    schema: z.object({ record: recordSchema, reminder: z.object({ reminder: z.number(), taskId: z.string().nullable(), assigneeId: z.string().nullable() }) }),
    idempotencyKey: newIdempotencyKey(),
  })

// ---- an action's evidence files (generic files routes, record type CapaAction) --------------------------------------------

export interface EvidenceFile {
  id: string
  name: string
  contentType: string
  createdAt: string
}
export const ACTION_RECORD_TYPE = 'CapaAction'
export const actionFiles = (api: ApiClient, actionId: string, signal?: AbortSignal): Promise<EvidenceFile[]> =>
  listFiles(api, { type: ACTION_RECORD_TYPE, id: actionId }, signal).then((answer) =>
    answer.files.filter((file) => file.status === 'AVAILABLE').map((file) => ({ id: file.id, name: file.originalName, contentType: file.contentType, createdAt: file.createdAt })),
  )

/** A file of an action (its evidence): announce → the bytes to the store → complete (an OFFICE file of the CAPA's company). */
export async function uploadEvidence(api: ApiClient, target: { companyId: string; actionId: string }, file: Blob, name: string): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: target.companyId,
    record: { type: ACTION_RECORD_TYPE, id: target.actionId },
    kind: file.type.startsWith('image/') ? 'PHOTO' : 'ATTACHMENT',
    name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

/** Where a stored file opens (a kept 8D version, an evidence file): the presigned address, through this app's `/api`. */
export const fileAddress = (api: ApiClient, fileId: string): Promise<string> =>
  downloadLink(api, fileId).then((answer) => {
    const url = answer.download.url
    return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
  })

// ---- the 8D report -----------------------------------------------------------------------------------------------------------

export type ReportLanguage = 'it' | 'en'
/** GET …/report?language=: the 8D with the "preview" banner, made in memory (stored nowhere). */
export const reportPreview = (api: ApiClient, capaId: string, language: ReportLanguage, signal?: AbortSignal): Promise<Uint8Array> =>
  api.bytes(`/quality/capa/${seg(capaId)}/report`, { query: { language }, signal })
/** POST …/report: a version kept (the same contents give the newest back, `made` false). */
export const keepReport = (api: ApiClient, capaId: string, language: ReportLanguage, idempotencyKey: string) =>
  api.post(`/quality/capa/${seg(capaId)}/report`, { body: { language }, schema: z.object({ report: reportVersion, made: z.boolean() }), idempotencyKey })

/** B-W2b-192: "Share with the customer" — the newest kept 8D copied onto the complaint, shared with its customer. */
export const shareWithCustomer = (api: ApiClient, complaintId: string, capaId: string, idempotencyKey: string) =>
  api.post(`/quality/complaints/${seg(complaintId)}/share-eight-d`, {
    body: { capaId },
    schema: z.object({ shared: z.object({ fileId: z.string(), version: z.number(), made: z.boolean() }) }).passthrough(),
    idempotencyKey,
  }).then((answer) => answer.shared)

// ---- pickers of New CAPA ---------------------------------------------------------------------------------------------------

export interface SourceChoice {
  recordType: SourceType
  recordId: string
  number: string
  title: string
  companyId: string
}
const ncrPick = z.object({ items: z.array(z.object({ id: z.string(), number: z.string(), title: z.string(), companyId: z.string() })) })
const complaintPick = z.object({ complaints: z.array(z.object({ id: z.string(), number: z.string(), summary: z.string(), companyId: z.string() })) })

/** Open NCRs and complaints that match the words (each list only with its own view right). */
export async function findSources(api: ApiClient, q: string, can: { ncrView: boolean; complaintsView: boolean }, signal?: AbortSignal): Promise<SourceChoice[]> {
  const words = q.trim().slice(0, 100)
  const [ncrs, complaints] = await Promise.all([
    can.ncrView ? api.get('/quality/ncr', { query: clean({ open: 'true', q: words }), schema: ncrPick, signal }).then((answer) => answer.items.slice(0, 20)) : Promise.resolve([]),
    can.complaintsView ? api.get('/quality/complaints', { query: clean({ view: 'open', q: words, limit: 20 }), schema: complaintPick, signal }).then((answer) => answer.complaints) : Promise.resolve([]),
  ])
  return [
    ...ncrs.map((row) => ({ recordType: 'Nonconformance' as const, recordId: row.id, number: row.number, title: row.title, companyId: row.companyId })),
    ...complaints.map((row) => ({ recordType: 'Complaint' as const, recordId: row.id, number: row.number, title: row.summary, companyId: row.companyId })),
  ]
}

const preview = z.object({
  records: z.array(
    z.object({
      recordType: z.enum(SOURCE_TYPES),
      recordId: z.string(),
      number: z.string(),
      title: z.string().nullable(),
      companyId: z.string(),
      state: z.string(),
      reasons: z.array(z.enum(ESCALATION_REASONS)),
      escalatedTo: z.object({ capaId: z.string(), number: z.string(), status: z.enum(CAPA_STATUSES) }).nullable(),
      problem: z.object({ path: z.string(), message: z.string() }).nullable(),
    }),
  ),
  companyId: z.string().nullable(),
  sameCompany: z.boolean(),
  ready: z.boolean(),
  mayOpen: z.boolean(),
})
export type SourcePreview = z.infer<typeof preview>
/** The records a New CAPA opened from an address names (`?new=1&from=<type>&ids=`): each with why it is worth a CAPA, or why it cannot go. */
export const sourcePreview = (api: ApiClient, recordType: SourceType, ids: readonly string[], signal?: AbortSignal): Promise<SourcePreview> =>
  api.get('/quality/capa/escalate', { query: { recordType, ids: ids.join(',') }, schema: preview.passthrough(), signal })

export interface CustomerChoice {
  id: string
  code: string
  name: string
}
const customers = z.object({ parties: z.array(z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable().optional() })) })
/** The company's customers and brands (parties.view): whom an 8D is written for. */
export const findCustomers = (api: ApiClient, q: string, signal?: AbortSignal): Promise<CustomerChoice[]> =>
  api
    .get('/parties', { query: clean({ role: 'CUSTOMER,BRAND', q: q.trim() || undefined, limit: 50 }), schema: customers, signal })
    .then((answer) => answer.parties.map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })))
