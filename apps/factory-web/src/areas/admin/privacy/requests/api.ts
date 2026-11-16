import { z } from 'zod'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS, REQUEST_HELD, type DataRequestKind, type DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Data requests (B-W2b-414 on B-W2b-405's API, apps/factory-api platform/privacy/requests; PLT-202, PLT-203; GDPR arts. 12, 15-17,
 * 20): every call of Admin › Privacy › Data requests and the shapes it reads. The API's English words (a held action's `words`,
 * a failed collection's reason) are left out on purpose: the screen says its own from the codes. Every write carries the
 * version the screen read and one Idempotency-Key per attempt.
 */

const id = z.string()
const ref = z.object({ id, name: z.string() })
const may = z.object({ allowed: z.boolean(), held: z.object({ code: z.enum(REQUEST_HELD) }).nullable() })

// B-W2b-GF1 (G274): `deleteAfter`, the day the package is deleted (30 days after it was made); optional for an older API.
export const packageSchema = z.object({ fileId: id, name: z.string(), sizeBytes: z.number(), sha256: z.string(), madeAt: z.string().nullable(), deleteAfter: z.string().nullable().optional() })
/** NONE: never asked; RUNNING: being collected; READY: the package is there; FAILED: the worker could not make it. */
export const collectSchema = z.object({ state: z.enum(['NONE', 'RUNNING', 'READY', 'FAILED']), at: z.string().nullable() })

export const requestSchema = z.object({
  id,
  company: z.object({ id, code: z.string(), name: z.string() }),
  person: z.object({ kind: z.enum(DATA_SUBJECT_KINDS), recordType: z.string(), recordId: id, name: z.string(), erased: z.boolean() }),
  kind: z.enum(DATA_REQUEST_KINDS),
  receivedAt: z.string(),
  dueAt: z.string(),
  originalDueAt: z.string(),
  extended: z.boolean(),
  extensionReason: z.string().nullable(),
  overdue: z.boolean(),
  hoursLeft: z.number(),
  note: z.string().nullable(),
  identityCheckedAt: z.string().nullable(),
  identityCheckedBy: ref.nullable(),
  status: z.enum(DATA_REQUEST_STATUSES),
  decidedAt: z.string().nullable(),
  decidedBy: ref.nullable(),
  refusalReason: z.string().nullable(),
  package: packageSchema.nullable(),
  collect: collectSchema.nullable(),
  erasure: z.object({ records: z.number(), anonymised: z.number(), deleted: z.number(), kept: z.number() }).nullable(),
  version: z.number(),
  actions: z.object({ checkIdentity: may, extend: may, collect: may, openPackage: may, erase: may, close: may, refuse: may, withdraw: may }),
})
export type DataRequest = z.infer<typeof requestSchema>
export type RequestActionName = keyof DataRequest['actions']

const listAnswer = z.object({ requests: z.array(requestSchema), counts: z.object({ open: z.number(), overdue: z.number() }) })
export type RequestList = z.infer<typeof listAnswer>
const oneAnswer = z.object({ request: requestSchema })
const download = z.object({ download: z.object({ url: z.string(), expiresAt: z.string() }) })

export const REQUEST_VIEWS = ['open', 'closed', 'all'] as const
export type RequestView = (typeof REQUEST_VIEWS)[number]

export interface RequestQuery {
  readonly companyId: string | null
  readonly view: RequestView
  readonly kind: DataRequestKind | null
}

const enc = encodeURIComponent
const at = (requestId: string, rest = '') => `/privacy/requests/${enc(requestId)}${rest}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

/** Open first by the due time in force, then the closed ones newest first (at most 200), with the open and late counts. */
export const listRequests = (api: ApiClient, query: RequestQuery, signal?: AbortSignal): Promise<RequestList> =>
  api.get('/privacy/requests', { query: { companyId: query.companyId ?? undefined, view: query.view, kind: query.kind ?? undefined }, schema: listAnswer, signal })

export const getRequest = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<DataRequest> => api.get(at(requestId), { schema: oneAnswer, signal }).then((answer) => answer.request)

export interface NewRequestBody {
  readonly companyId: string
  readonly personKind: DataSubjectKind
  readonly personRecordType?: string
  readonly personRecordId: string
  readonly kind: DataRequestKind
  readonly receivedAt?: string
  readonly note?: string | null
}

export const createRequest = (api: ApiClient, body: NewRequestBody, idempotencyKey?: string): Promise<DataRequest> =>
  api.post('/privacy/requests', { body, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

/** RECEIVED → IN_PROGRESS: how the identity was checked goes in the audit's reason (never a document number). */
export const checkIdentity = (api: ApiClient, request: Pick<DataRequest, 'id' | 'version'>, how: string, idempotencyKey?: string) =>
  api.post(at(request.id, '/identity'), { body: { version: request.version, how }, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

export const extendRequest = (api: ApiClient, request: Pick<DataRequest, 'id' | 'version'>, months: 1 | 2, reason: string, idempotencyKey?: string) =>
  api.post(at(request.id, '/extend'), { body: { version: request.version, months, reason }, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

/** 202: the worker collects the package (the request's collect state is RUNNING until READY or FAILED). */
export const collectPackage = (api: ApiClient, requestId: string, idempotencyKey?: string) =>
  api.post(at(requestId, '/collect'), { body: {}, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

/** A link to the package for 60 seconds; the read log records the download. */
export const packageLink = (api: ApiClient, requestId: string) => api.get(at(requestId, '/package'), { schema: download }).then((answer) => answer.download.url)

export const finishRequest = (api: ApiClient, request: Pick<DataRequest, 'id' | 'version'>, idempotencyKey?: string) =>
  api.post(at(request.id, '/done'), { body: { version: request.version }, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

export const refuseRequest = (api: ApiClient, request: Pick<DataRequest, 'id' | 'version'>, reason: string, idempotencyKey?: string) =>
  api.post(at(request.id, '/refuse'), { body: { version: request.version, reason }, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

export const withdrawRequest = (api: ApiClient, request: Pick<DataRequest, 'id' | 'version'>, reason: string, idempotencyKey?: string) =>
  api.post(at(request.id, '/withdraw'), { body: { version: request.version, ...(reason.trim() ? { reason } : {}) }, schema: oneAnswer, ...key(idempotencyKey) }).then((answer) => answer.request)

// ---- finding the person (New data request) ----------------------------------------------------------------------------------
// Each kind reads its own list with that list's permission (the API applies its field security); a 403 is said in words.

/** One person a request may name: the record that names them and how the picker shows them. */
export interface PersonOption {
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly companyId: string | null
}

const partiesAnswer = z.object({ parties: z.array(z.object({ id, code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), companyId: z.string().nullable() })) })
const partyAnswer = z.object({ party: z.object({ id, companyId: z.string().nullable(), contacts: z.array(z.object({ id, name: z.string(), status: z.string() })) }) })
const inquiriesAnswer = z.object({ rows: z.array(z.object({ id, number: z.string(), companyId: z.string(), fromWords: z.string(), prospect: z.boolean() })) })
const reportsAnswer = z.object({ reports: z.array(z.object({ id, number: z.string(), companyId: z.string(), receivedAt: z.string() })) })
const usersAnswer = z.object({ users: z.array(z.object({ id, displayName: z.string(), email: z.string(), audience: z.enum(['OFFICE', 'PARTNER']).optional() })) })
const employeesAnswer = z.object({ employees: z.array(z.object({ id, companyId: z.string(), displayName: z.string(), employeeCode: z.string().nullable() })) })

const q = (text: string) => (text.trim() ? text.trim() : undefined)

/** The customers a search finds (a contact is picked inside one). */
export const findCustomers = (api: ApiClient, text: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api
    .get('/parties', { query: { q: q(text), role: 'CUSTOMER,BRAND', limit: 50 }, schema: partiesAnswer, signal })
    .then((answer) => answer.parties.map((party) => ({ recordType: 'Party', recordId: party.id, label: `${party.code} · ${party.tradeName ?? party.legalName}`, companyId: party.companyId })))

/** The contacts of one customer. */
export const contactsOf = (api: ApiClient, partyId: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api
    .get(`/parties/${enc(partyId)}`, { schema: partyAnswer, signal })
    .then((answer) => answer.party.contacts.map((contact) => ({ recordType: 'PartyContact', recordId: contact.id, label: contact.name, companyId: answer.party.companyId })))

/** The people who asked as prospects (no customer yet). */
export const findProspects = (api: ApiClient, text: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api
    .get('/sales/inquiries', { query: { prospect: 'true', tile: 'ALL', q: q(text), limit: 50 }, schema: inquiriesAnswer, signal })
    .then((answer) => answer.rows.filter((row) => row.prospect).map((row) => ({ recordType: 'Inquiry', recordId: row.id, label: `${row.number} · ${row.fromWords}`, companyId: row.companyId })))

/** The product-safety reports (the list never names the reporter: the request names them once recorded). */
export const findReports = (api: ApiClient, text: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api
    .get('/sales/safety-reports', { query: { view: 'all', q: q(text), limit: 50 }, schema: reportsAnswer, signal })
    .then((answer) => answer.reports.map((row) => ({ recordType: 'ProductSafetyReport', recordId: row.id, label: row.number, companyId: row.companyId })))

/** The office accounts (partners are a customer's contacts: their request names the contact). */
export const findUsers = (api: ApiClient, text: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api.get('/auth/users', { schema: usersAnswer, signal }).then((answer) => {
    const wanted = text.trim().toLocaleLowerCase()
    return answer.users
      .filter((user) => user.audience !== 'PARTNER')
      .filter((user) => !wanted || user.displayName.toLocaleLowerCase().includes(wanted) || user.email.toLocaleLowerCase().includes(wanted))
      .slice(0, 50)
      .map((user) => ({ recordType: 'User', recordId: user.id, label: user.displayName, companyId: null }))
  })

/** The employees (a worker's request names the employee: their floor accounts follow). */
export const findEmployees = (api: ApiClient, text: string, signal?: AbortSignal): Promise<PersonOption[]> =>
  api
    .get('/people/employees', { query: { q: q(text), limit: 50 }, schema: employeesAnswer, signal })
    .then((answer) => answer.employees.map((row) => ({ recordType: 'Employee', recordId: row.id, label: row.employeeCode ? `${row.displayName} · ${row.employeeCode}` : row.displayName, companyId: row.companyId })))
