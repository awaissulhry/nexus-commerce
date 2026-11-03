import { z } from 'zod'
import { DEADLINE_KINDS, DEADLINE_STATUSES, ITEM_STATES, REPEAT_UNITS, type DeadlineKind, type RepeatUnit } from '@nexus/factory-domain/safety/calendar/rules'
import { APPOINTMENT_SIGN_METHODS, RLS_NOTICE_STATUSES, SAFETY_ROLES, type AppointmentSignMethod, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import type { ApiClient } from '../../../lib/api/client'
import { completeUpload, downloadLink, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Plant › Health & safety › Safety calendar (SCR-267; B-W2b-120 on the API of the same step, apps/factory-api
 * modules/safety/{calendar,organisation}): the calendar and its tiles, the deadlines typed here, the safety organisation,
 * the RLS notices to INAIL, and the files of an appointment (the letter), a notice (INAIL's receipt) and a deadline (the
 * evidence) through the generic files routes. Each answer's shape is checked (zod mirrors of the API's contracts; unknown
 * fields are dropped). Reading is safety.view; a deadline write safety.calendar.manage; an appointment or a notice write
 * safety.organisation.manage; a file files.upload. Every write carries the version read and its own Idempotency-Key.
 * The API's English messages are never shown: the screens say their own words from the codes.
 */

const codeName = z.object({ code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const seg = (value: string) => encodeURIComponent(value)

// ---- the calendar ---------------------------------------------------------------------------------------------------------

export const itemSchema = z.object({
  key: z.string(),
  kind: z.string(),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string().nullable(),
  site: codeName.nullable(),
  dueOn: z.string(),
  state: z.enum(ITEM_STATES),
  toConfirm: z.boolean(),
  count: z.number().int().nullable(),
  params: z.record(z.string(), z.string()),
  ownerId: z.string().nullable(),
  owner: z.string().nullable(),
  evidence: z.object({ required: z.boolean(), onFile: z.boolean() }).nullable(),
  law: z.string().nullable(),
  source: z.object({ page: z.string().nullable(), recordType: z.string().nullable(), recordId: z.string().nullable(), parentType: z.string().nullable(), parentId: z.string().nullable() }),
  editable: z.boolean(),
})
export type CalendarItem = z.infer<typeof itemSchema>

const calendarAnswer = z.object({ items: z.array(itemSchema), from: z.string(), to: z.string(), today: z.string(), failed: z.array(z.string()), canManage: z.boolean(), canUpload: z.boolean() })
export type CalendarAnswer = z.infer<typeof calendarAnswer>

const countsAnswer = z.object({ overdue: z.number(), dueSoon: z.number(), rolesWithoutPerson: z.number(), rlsPending: z.number(), failed: z.array(z.string()), today: z.string() })
export type CountsAnswer = z.infer<typeof countsAnswer>

/**
 * GET /safety/calendar (safety.view): every item due in the window (≤ 400 days), the sources that failed. `late`: also what
 * is still OPEN from before `from` (the List: an item overdue for months is still on it; the Month view leaves it off).
 */
export const readCalendar = (api: ApiClient, window: { from: string; to: string; siteId: string | null; late?: boolean }, signal?: AbortSignal) =>
  api.get('/safety/calendar', { query: { from: window.from, to: window.to, ...(window.siteId ? { siteId: window.siteId } : {}), ...(window.late ? { late: 'true' } : {}) }, schema: calendarAnswer, signal })

/** GET /safety/calendar/counts (safety.view): the four tiles. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/calendar/counts', { query: siteId ? { siteId } : {}, schema: countsAnswer, signal })

// ---- the deadlines typed here ---------------------------------------------------------------------------------------------

export const deadlineSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string().nullable(),
  site: codeName.nullable(),
  title: z.string(),
  kind: z.enum(DEADLINE_KINDS),
  dueOn: z.string(),
  repeatEvery: z.number().int().nullable(),
  repeatUnit: z.enum(REPEAT_UNITS).nullable(),
  ownerId: z.string().nullable(),
  owner: z.string().nullable(),
  evidenceRequired: z.boolean(),
  evidence: z.array(z.object({ fileId: z.string(), name: z.string(), kind: z.string(), at: z.string() })),
  status: z.enum(DEADLINE_STATUSES),
  state: z.enum(ITEM_STATES),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  doneNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  previousId: z.string().nullable(),
  nextId: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})
export type Deadline = z.infer<typeof deadlineSchema>

const deadlineRecord = z.object({
  deadline: deadlineSchema,
  earlier: z.array(z.object({ id: z.string(), dueOn: z.string(), status: z.enum(DEADLINE_STATUSES), doneAt: z.string().nullable() })),
  canUpload: z.boolean(),
  today: z.string(),
})
export type DeadlineRecord = z.infer<typeof deadlineRecord>

const ownerSchema = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
export type Owner = z.infer<typeof ownerSchema>

/** GET /safety/deadlines/:id (safety.view): the deadline, its earlier occurrences, whether a file may be added. */
export const readDeadline = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/deadlines/${seg(id)}`, { schema: deadlineRecord, signal })

/** GET /safety/deadlines/owners (safety.calendar.manage): who may own a deadline of the company. */
export const readOwners = async (api: ApiClient, companyId: string, signal?: AbortSignal) => (await api.get('/safety/deadlines/owners', { query: { companyId }, schema: z.object({ owners: z.array(ownerSchema) }), signal })).owners

export interface NewDeadlineBody {
  companyId: string
  siteId: string | null
  title: string
  kind: DeadlineKind
  dueOn: string
  repeatEvery: number | null
  repeatUnit: RepeatUnit | null
  ownerId: string | null
  evidenceRequired: boolean
  note?: string
}

/** POST /safety/deadlines (safety.calendar.manage). */
export const createDeadline = async (api: ApiClient, body: NewDeadlineBody, idempotencyKey: string) => (await api.post('/safety/deadlines', { body, schema: z.object({ deadline: deadlineSchema }), idempotencyKey })).deadline

export interface DeadlineEdit {
  version: number
  title?: string
  dueOn?: string
  repeatEvery?: number | null
  repeatUnit?: RepeatUnit | null
  ownerId?: string | null
  evidenceRequired?: boolean
  note?: string | null
}

/** PATCH /safety/deadlines/:id (safety.calendar.manage): only the fields that changed, at the version read. */
export const editDeadline = async (api: ApiClient, id: string, body: DeadlineEdit, idempotencyKey: string) =>
  (await api.request('PATCH', `/safety/deadlines/${seg(id)}`, { body, schema: z.object({ deadline: deadlineSchema }), idempotencyKey })).deadline

/** POST /safety/deadlines/:id/done (safety.calendar.manage): done (a repeating one answers its next occurrence). */
export const markDeadlineDone = (api: ApiClient, id: string, body: { version: number; note?: string }, idempotencyKey: string) =>
  api.post(`/safety/deadlines/${seg(id)}/done`, { body, schema: z.object({ deadline: deadlineSchema, next: deadlineSchema.nullable() }), idempotencyKey })

/** POST /safety/deadlines/:id/cancel (safety.calendar.manage): cancelled with the reason. */
export const cancelDeadline = async (api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  (await api.post(`/safety/deadlines/${seg(id)}/cancel`, { body, schema: z.object({ deadline: deadlineSchema }), idempotencyKey })).deadline

// ---- the safety organisation ----------------------------------------------------------------------------------------------

export const appointeeSchema = z.object({
  kind: z.enum(['EMPLOYEE', 'OUTSIDE']),
  employeeId: z.string().nullable(),
  name: z.string(),
  partyId: z.string().nullable(),
  partyName: z.string().nullable(),
  contactId: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
})

export const appointmentSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string().nullable(),
  site: codeName.nullable(),
  role: z.enum(SAFETY_ROLES),
  law: z.string(),
  appointee: appointeeSchema,
  shift: ref.nullable(),
  fromDate: z.string(),
  untilDate: z.string().nullable(),
  endReason: z.string().nullable(),
  inForce: z.boolean(),
  ended: z.boolean(),
  signature: z.object({ signedAt: z.string(), method: z.enum(APPOINTMENT_SIGN_METHODS), signedName: z.string(), signedBy: z.string().nullable() }).nullable(),
  letter: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  training: z.object({ state: z.enum(['VALID', 'EXPIRED', 'NONE', 'NOT_TRACKED']), validUntil: z.string().nullable(), course: z.string().nullable() }),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})
export type Appointment = z.infer<typeof appointmentSchema>

export const noticeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  appointmentId: z.string(),
  role: z.enum(SAFETY_ROLES),
  appointee: z.string(),
  site: codeName.nullable(),
  appointedFrom: z.string(),
  dueOn: z.string(),
  status: z.enum(RLS_NOTICE_STATUSES),
  filedOn: z.string().nullable(),
  reference: z.string().nullable(),
  filedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  receipt: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})
export type RlsNotice = z.infer<typeof noticeSchema>

const placeSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), sites: z.array(ref) })
export type OrgPlace = z.infer<typeof placeSchema>
const missingSchema = z.object({ companyId: z.string(), siteId: z.string().nullable(), role: z.enum(SAFETY_ROLES) })
export type MissingRole = z.infer<typeof missingSchema>

const organisationAnswer = z.object({
  appointments: z.array(appointmentSchema),
  missing: z.array(missingSchema),
  companies: z.array(placeSchema),
  canManage: z.boolean(),
  canUpload: z.boolean(),
  law: z.string(),
  today: z.string(),
})
export type Organisation = z.infer<typeof organisationAnswer>

/** GET /safety/organisation (safety.view): who holds each role (in force and later; `ended` the history too), the missing roles. */
export const readOrganisation = (api: ApiClient, query: { siteId: string | null; ended: boolean }, signal?: AbortSignal) =>
  api.get('/safety/organisation', { query: { ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.ended ? { ended: 'true' } : {}) }, schema: organisationAnswer, signal })

const appointmentRecord = z.object({ appointment: appointmentSchema, notices: z.array(noticeSchema), today: z.string() })
export type AppointmentRecord = z.infer<typeof appointmentRecord>

/** GET /safety/appointments/:id (safety.view): one appointment with its RLS notices. */
export const readAppointment = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/appointments/${seg(id)}`, { schema: appointmentRecord, signal })

const personSchema = z.object({ id: z.string(), name: z.string(), employeeCode: z.string().nullable(), site: ref })
export type OrgPerson = z.infer<typeof personSchema>
const contactSchema = z.object({ partyId: z.string(), partyName: z.string(), contactId: z.string().nullable(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })
export type OrgContact = z.infer<typeof contactSchema>

/** GET /safety/organisation/people (safety.organisation.manage): the company's active people, names only. */
export const readPeople = (api: ApiClient, companyId: string, q: string | null, signal?: AbortSignal) =>
  api.get('/safety/organisation/people', { query: { companyId, ...(q ? { q } : {}) }, schema: z.object({ people: z.array(personSchema), complete: z.boolean() }), signal })

/** GET /safety/organisation/contacts (safety.organisation.manage): outside organisations' contacts. */
export const readContacts = (api: ApiClient, companyId: string, q: string | null, signal?: AbortSignal) =>
  api.get('/safety/organisation/contacts', { query: { companyId, ...(q ? { q } : {}) }, schema: z.object({ contacts: z.array(contactSchema), complete: z.boolean() }), signal })

/** GET /safety/organisation/shifts (safety.organisation.manage): the company's shifts (teams per shift). */
export const readShifts = async (api: ApiClient, companyId: string, signal?: AbortSignal) => (await api.get('/safety/organisation/shifts', { query: { companyId }, schema: z.object({ shifts: z.array(ref) }), signal })).shifts

export interface NewAppointmentBody {
  companyId: string
  siteId: string | null
  role: SafetyRole
  employeeId?: string
  outsideName?: string
  outsidePartyId?: string
  outsideContactId?: string
  shiftPatternId?: string
  fromDate: string
  untilDate?: string
  note?: string
  noticeDueOn?: string
  noticeFiled?: { filedOn: string; reference: string }
}

/** POST /safety/appointments (safety.organisation.manage): the appointment, and an RLS's or RLST's notice to INAIL. */
export const createAppointment = (api: ApiClient, body: NewAppointmentBody, idempotencyKey: string) =>
  api.post('/safety/appointments', { body, schema: z.object({ appointment: appointmentSchema, notice: noticeSchema.nullable() }), idempotencyKey })

/** PATCH /safety/appointments/:id (safety.organisation.manage): its note. */
export const editAppointmentNote = async (api: ApiClient, id: string, body: { version: number; note: string | null }, idempotencyKey: string) =>
  (await api.request('PATCH', `/safety/appointments/${seg(id)}`, { body, schema: z.object({ appointment: appointmentSchema }), idempotencyKey })).appointment

/** POST /safety/appointments/:id/sign (safety.organisation.manage): the appointee's signature, written once. */
export const signAppointment = async (api: ApiClient, id: string, body: { version: number; method: AppointmentSignMethod; signedName: string }, idempotencyKey: string) =>
  (await api.post(`/safety/appointments/${seg(id)}/sign`, { body, schema: z.object({ appointment: appointmentSchema }), idempotencyKey })).appointment

/** POST /safety/appointments/:id/end (safety.organisation.manage): the last day and why. */
export const endAppointment = async (api: ApiClient, id: string, body: { version: number; untilDate: string; endReason: string }, idempotencyKey: string) =>
  (await api.post(`/safety/appointments/${seg(id)}/end`, { body, schema: z.object({ appointment: appointmentSchema }), idempotencyKey })).appointment

// ---- the RLS notices to INAIL ---------------------------------------------------------------------------------------------

const noticesAnswer = z.object({ notices: z.array(noticeSchema), canManage: z.boolean(), law: z.string(), today: z.string() })
export type NoticesAnswer = z.infer<typeof noticesAnswer>

/** GET /safety/rls-notices (safety.view): every notice (pending first), at most 200. */
export const readNotices = (api: ApiClient, signal?: AbortSignal) => api.get('/safety/rls-notices', { query: { status: 'ALL', limit: 200 }, schema: noticesAnswer, signal })

const noticeAnswer = z.object({ notice: noticeSchema })

/** POST /safety/rls-notices/:id/file (safety.organisation.manage): filed on the INAIL portal (a manual send), its reference. */
export const fileNotice = async (api: ApiClient, id: string, body: { version: number; filedOn: string; reference: string; note?: string }, idempotencyKey: string) =>
  (await api.post(`/safety/rls-notices/${seg(id)}/file`, { body, schema: noticeAnswer, idempotencyKey })).notice

/** POST /safety/rls-notices/:id/due (safety.organisation.manage): the due day confirmed. */
export const setNoticeDue = async (api: ApiClient, id: string, body: { version: number; dueOn: string }, idempotencyKey: string) =>
  (await api.post(`/safety/rls-notices/${seg(id)}/due`, { body, schema: noticeAnswer, idempotencyKey })).notice

/** POST /safety/rls-notices/:id/cancel (safety.organisation.manage): cancelled with the reason. */
export const cancelNotice = async (api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  (await api.post(`/safety/rls-notices/${seg(id)}/cancel`, { body, schema: noticeAnswer, idempotencyKey })).notice

// ---- files (the generic files routes) --------------------------------------------------------------------------------------

/** The record types whose files this page keeps (the API registers them for the files routes). */
export type SafetyFileRecord = 'SafetyAppointment' | 'RlsNotice' | 'SafetyDeadline'

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
])

/**
 * The file kind of an upload: a letter or a receipt is a DOCUMENT when it is a PDF or a text document, a scan as a picture
 * an ATTACHMENT (DOCUMENT takes no image); a deadline's evidence (photos, a PDF, a report) is an ATTACHMENT.
 */
export function fileKindFor(record: SafetyFileRecord, contentType: string): 'DOCUMENT' | 'ATTACHMENT' {
  if (record === 'SafetyDeadline') return 'ATTACHMENT'
  return DOCUMENT_TYPES.has(contentType) ? 'DOCUMENT' : 'ATTACHMENT'
}

/** What a file field takes (PDF or a picture; a deadline's evidence also an office document). */
export const ACCEPT: Readonly<Record<SafetyFileRecord, string>> = { SafetyAppointment: '.pdf,.jpg,.jpeg,.png,.webp,.heic', RlsNotice: '.pdf,.jpg,.jpeg,.png,.webp,.heic', SafetyDeadline: '.pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx,.xlsx,.csv,.txt' }

/** One file onto a record (files.upload): announce, send the bytes, confirm. Office only. */
export async function uploadFile(api: ApiClient, record: { type: SafetyFileRecord; id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const { file: stored, upload } = await requestUpload(api, {
    companyId: record.companyId,
    record: { type: record.type, id: record.id },
    kind: fileKindFor(record.type, contentType),
    name: file.name || 'file.pdf',
    contentType,
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

/** A file's address to open in a new tab (a presigned GET of 60 seconds; a same-origin path goes through this app's /api). */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const { download } = await downloadLink(api, fileId)
  return download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url
}
