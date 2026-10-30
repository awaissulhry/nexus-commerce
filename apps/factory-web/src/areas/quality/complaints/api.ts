import { z } from 'zod'
import {
  COMPLAINT_ACTIONS,
  COMPLAINT_CATEGORIES,
  COMPLAINT_CHANNELS,
  COMPLAINT_SEVERITIES,
  COMPLAINT_STATUSES,
  COMPLAINT_VIEWS,
  HELD_CODES,
  OFFICE_CHANNELS,
  SAFETY_STATES,
  STATUS_MOVES,
} from '@nexus/factory-domain/quality/complaints/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Quality › Complaints (SCR-113 W2a part; apps/factory-api modules/quality/complaints, B-W2a-65), each
 * answer checked with a zod shape that mirrors the API's contract (the web never imports the API source): unknown fields
 * are dropped, so a new field never breaks the page. The order's value is the price grain: the API leaves it out for a
 * reader without it (optional here). Beside the complaints: the pickers of the Log dialog (customers, their contacts,
 * orders, shipments and returns, styles), the company's sites (an NCR or a repair from a complaint), the complaint's
 * photos (the generic files routes, record type Complaint) and the routes of the steps this one hands over to (an NCR,
 * B-W2a-47; a repair, B-W2a-57).
 */

export { COMPLAINT_ACTIONS, COMPLAINT_CATEGORIES, COMPLAINT_CHANNELS, COMPLAINT_SEVERITIES, COMPLAINT_STATUSES, COMPLAINT_VIEWS, HELD_CODES, OFFICE_CHANNELS, SAFETY_STATES, STATUS_MOVES }
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number]
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number]
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number]
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number]
export type OfficeChannel = (typeof OFFICE_CHANNELS)[number]
export type ComplaintView = (typeof COMPLAINT_VIEWS)[number]
export type ComplaintAction = (typeof COMPLAINT_ACTIONS)[number]
export type HeldCode = (typeof HELD_CODES)[number]
export type StatusMove = (typeof STATUS_MOVES)[number]
export type SafetyState = (typeof SAFETY_STATES)[number]

const seg = (value: string) => encodeURIComponent(value)
const clean = <T extends Record<string, string | number | boolean | null | undefined>>(query: T) =>
  Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Record<string, string | number | boolean>

const person = z.object({ id: z.string(), name: z.string() })
const numbered = z.object({ id: z.string(), number: z.string(), status: z.string() })
const styleRef = z.object({ id: z.string(), code: z.string(), name: z.string() })
const issue = z.object({ path: z.string(), message: z.string() })

const safety = z.object({ state: z.enum(SAFETY_STATES), raisedAt: z.string().nullable(), acknowledgedAt: z.string().nullable(), acknowledgedById: z.string().nullable() })
const registerRef = z.object({ id: z.string(), reference: z.string(), status: z.string(), risk: z.string() })
/** The order's net value is the price grain: absent for a reader without it. */
const orderRef = z.object({ id: z.string(), number: z.string(), status: z.string(), currency: z.string(), netAmount: z.number().optional() })

export const complaintRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  status: z.enum(COMPLAINT_STATUSES),
  channel: z.enum(COMPLAINT_CHANNELS),
  receivedAt: z.string(),
  party: z.object({ id: z.string(), code: z.string(), legalName: z.string() }),
  customerRef: z.string().nullable(),
  order: orderRef.nullable(),
  shipment: numbered.nullable(),
  return: numbered.nullable(),
  style: styleRef.nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  category: z.enum(COMPLAINT_CATEGORIES).nullable(),
  severity: z.enum(COMPLAINT_SEVERITIES).nullable(),
  ownerId: z.string().nullable(),
  answerDueOn: z.string().nullable(),
  answeredAt: z.string().nullable(),
  safety,
  register: registerRef.nullable(),
  ncrs: z.array(z.object({ id: z.string(), number: z.string(), stage: z.string() })),
  summary: z.string(),
})
export type ComplaintRow = z.infer<typeof complaintRowSchema>

export const complaintSchema = complaintRowSchema.extend({
  description: z.string(),
  contact: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  style: styleRef.extend({ ppeCategory: z.string() }).nullable(),
  garment: z
    .object({
      madeOn: z.string(),
      workOrderNumber: z.string(),
      batchNumber: z.string().nullable(),
      shipment: z.object({ id: z.string(), number: z.string() }).nullable(),
      forThisCustomer: z.boolean(),
    })
    .nullable(),
  triagedAt: z.string().nullable(),
  triagedById: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  version: z.number(),
  repairs: z.array(z.object({ id: z.string(), number: z.string(), stage: z.string() })),
  evidence: z.object({ kind: z.enum(['serial', 'batch']), subject: z.string() }).nullable(),
  suggestedAnswerDueOn: z.string().nullable(),
  actions: z.array(z.object({ action: z.enum(COMPLAINT_ACTIONS), allowed: z.boolean(), held: z.enum(HELD_CODES).nullable() })),
  people: z.array(person),
})
export type Complaint = z.infer<typeof complaintSchema>

const oneComplaint = z.object({ complaint: complaintSchema })
const withWarnings = z.object({ complaint: complaintSchema, warnings: z.array(issue) })
const registerAnswer = z.object({ entryId: z.string(), reference: z.string(), opened: z.boolean() })

// ---- the list and its tiles ---------------------------------------------------------------------------------------------

export interface ComplaintQuery {
  view?: ComplaintView | null
  status?: string | null
  category?: ComplaintCategory | null
  severity?: ComplaintSeverity | null
  partyId?: string | null
  salesOrderId?: string | null
  shipmentId?: string | null
  returnId?: string | null
  owner?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number
}

const listSchema = z.object({ complaints: z.array(complaintRowSchema), nextCursor: z.string().nullable(), people: z.array(person), asOf: z.string() })
export type ComplaintPage = z.infer<typeof listSchema>

export function listComplaints(api: ApiClient, query: ComplaintQuery, signal?: AbortSignal): Promise<ComplaintPage> {
  return api.get('/quality/complaints', {
    query: clean({
      view: query.view,
      status: query.status,
      category: query.category,
      severity: query.severity,
      partyId: query.partyId,
      salesOrderId: query.salesOrderId,
      shipmentId: query.shipmentId,
      returnId: query.returnId,
      owner: query.owner,
      q: query.q?.trim(),
      cursor: query.cursor,
      limit: query.limit,
    }),
    schema: listSchema,
    signal,
  })
}

const alertSchema = z.object({ id: z.string(), number: z.string(), summary: z.string(), style: styleRef.nullable(), batchNumber: z.string().nullable(), serial: z.string().nullable(), raisedAt: z.string(), version: z.number() })
export type SafetyAlert = z.infer<typeof alertSchema>
const countsSchema = z.object({
  tiles: z.object({ new: z.number(), safety: z.number(), dueSoon: z.number(), open: z.number(), answeredMonth: z.number() }),
  safetyAlerts: z.array(alertSchema),
  moreSafetyAlerts: z.number(),
  asOf: z.string(),
})
export type ComplaintCounts = z.infer<typeof countsSchema>

export const complaintCounts = (api: ApiClient, signal?: AbortSignal): Promise<ComplaintCounts> => api.get('/quality/complaints/counts', { schema: countsSchema, signal })

const peopleSchema = z.object({ owners: z.array(person), told: z.array(z.object({ id: z.string(), name: z.string(), as: z.enum(['OWNER', 'QUALITY']) })) })
export type ComplaintPeople = z.infer<typeof peopleSchema>

/** Who may follow a complaint up (the triage's owners) and whom a safety alert tells, at a company. */
export const complaintPeople = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<ComplaintPeople> =>
  api.get('/quality/complaints/people', { query: { companyId }, schema: peopleSchema, signal })

// ---- log one ------------------------------------------------------------------------------------------------------------

export interface LogBody {
  companyId: string
  partyId: string
  contactId?: string | null
  customerRef?: string | null
  channel: OfficeChannel
  receivedAt?: string
  description: string
  salesOrderId?: string | null
  shipmentId?: string | null
  returnId?: string | null
  styleId?: string | null
  size?: string | null
  serial?: string | null
  batchNumber?: string | null
  internalNote?: string | null
}

const previewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  warnings: z.array(issue),
  draft: z.object({
    companyId: z.string().nullable(),
    partyId: z.string().nullable(),
    styleId: z.string().nullable(),
    size: z.string().nullable(),
    batchNumber: z.string().nullable(),
    shipmentId: z.string().nullable(),
    salesOrderId: z.string().nullable(),
  }),
  garment: z.object({ madeOn: z.string(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), shipment: z.object({ id: z.string(), number: z.string() }).nullable(), forThisCustomer: z.boolean() }).nullable(),
  others: z.array(z.object({ id: z.string(), number: z.string(), status: z.enum(COMPLAINT_STATUSES), receivedAt: z.string(), summary: z.string() })),
})
export type LogPreview = z.infer<typeof previewSchema>

/** What the dialog has so far: a scanned serial alone finds the garment, its shipment, order and customer. Writes nothing. */
export const previewComplaint = (api: ApiClient, body: Partial<LogBody>, signal?: AbortSignal): Promise<LogPreview> => api.post('/quality/complaints/preview', { body, schema: previewSchema, signal })

export const logComplaint = (api: ApiClient, body: LogBody, idempotencyKey: string) => api.post('/quality/complaints', { body, schema: withWarnings, idempotencyKey })

// ---- the record and its steps -------------------------------------------------------------------------------------------

export const getComplaint = (api: ApiClient, complaintId: string, signal?: AbortSignal): Promise<Complaint> =>
  api.get(`/quality/complaints/${seg(complaintId)}`, { schema: oneComplaint, signal }).then((answer) => answer.complaint)

export type ComplaintPatch = Partial<Omit<LogBody, 'companyId' | 'partyId' | 'description'>> & { description?: string }

export const changeComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, patch: ComplaintPatch) =>
  api.request('PATCH', `/quality/complaints/${seg(complaint.id)}`, { body: { version: complaint.version, ...patch }, schema: withWarnings, idempotencyKey: newIdempotencyKey() })

export interface TriageBody {
  category: ComplaintCategory
  severity: ComplaintSeverity
  ownerId: string
  answerDueOn: string
  styleId?: string | null
  risk?: 'ASSESSING' | 'YES'
  note?: string | null
}

export const triageComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, body: TriageBody, idempotencyKey: string) =>
  api.post(`/quality/complaints/${seg(complaint.id)}/triage`, {
    body: { version: complaint.version, ...body },
    schema: z.object({ complaint: complaintSchema, safetyRaised: z.boolean(), register: registerAnswer.nullable() }),
    idempotencyKey,
  })

export const acknowledgeComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, note: string | null) =>
  api.post(`/quality/complaints/${seg(complaint.id)}/acknowledge`, { body: { version: complaint.version, ...(note ? { note } : {}) }, schema: oneComplaint, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.complaint)

export const moveComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, to: StatusMove, note: string | null) =>
  api.post(`/quality/complaints/${seg(complaint.id)}/status`, { body: { version: complaint.version, to, ...(note ? { note } : {}) }, schema: oneComplaint, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.complaint)

export const closeComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, reason: string) =>
  api.post(`/quality/complaints/${seg(complaint.id)}/close`, { body: { version: complaint.version, reason }, schema: oneComplaint, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.complaint)

export const registerComplaint = (api: ApiClient, complaint: Pick<Complaint, 'id' | 'version'>, risk: 'NO' | 'ASSESSING' | 'YES') =>
  api.post(`/quality/complaints/${seg(complaint.id)}/register`, { body: { version: complaint.version, risk }, schema: z.object({ complaint: complaintSchema, register: registerAnswer }), idempotencyKey: newIdempotencyKey() })

// ---- the steps this one hands over to ------------------------------------------------------------------------------------

/** An NCR raised from the complaint (B-W2a-47: its content comes from the complaint; a complaint names no site). */
export const raiseNcrFrom = (api: ApiClient, complaintId: string, body: { siteId?: string; severity?: ComplaintSeverity }, idempotencyKey: string) =>
  api.post('/quality/ncr', {
    body: { from: { recordType: 'Complaint', recordId: complaintId }, ...(body.siteId ? { siteId: body.siteId } : {}), ...(body.severity ? { severity: body.severity } : {}) },
    schema: z.object({ record: z.object({ ncr: z.object({ id: z.string(), number: z.string() }) }) }),
    idempotencyKey,
  }).then((answer) => answer.record.ncr)

/** A repair made from the complaint (B-W2a-57: its garment and words; it waits for the garment unless it came with the customer). */
export const makeRepairFrom = (api: ApiClient, complaintId: string, body: { siteId?: string; received?: boolean }, idempotencyKey: string) =>
  api.post('/sales/repairs', {
    body: { complaintId, ...(body.siteId ? { siteId: body.siteId } : {}), ...(body.received ? { received: {} } : {}) },
    schema: z.object({ repair: z.object({ id: z.string(), number: z.string() }) }),
    idempotencyKey,
  }).then((answer) => answer.repair)

// ---- pickers --------------------------------------------------------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** The customers (and brands) a complaint may come from (parties.view). */
export async function listCustomers(api: ApiClient, signal?: AbortSignal): Promise<PartyOption[]> {
  const answer = await api.get('/parties', { query: { role: 'CUSTOMER,BRAND', limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
  return answer.parties
}

const contactOption = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), status: z.string() })
export type ContactOption = z.infer<typeof contactOption>

/** A customer's active contacts (parties.view). */
export async function listContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<ContactOption[]> {
  const answer = await api.get(`/parties/${seg(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactOption) }) }), signal })
  return answer.party.contacts.filter((contact) => contact.status === 'ACTIVE')
}

const docOption = z.object({ id: z.string(), number: z.string() })
export type DocOption = z.infer<typeof docOption>

/** The customer's orders (orders.view), newest first. */
export async function listOrders(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DocOption[]> {
  const answer = await api.get('/sales/orders', { query: { partyId, limit: 50 }, schema: z.object({ orders: z.array(docOption) }), signal })
  return answer.orders
}

/** The customer's shipments (shipping.view). */
export async function listShipments(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DocOption[]> {
  const answer = await api.get('/shipping/shipments', { query: { partyId, limit: 50 }, schema: z.object({ shipments: z.array(docOption) }), signal })
  return answer.shipments
}

/** The customer's returns (sales.returns.view). */
export async function listReturns(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DocOption[]> {
  const answer = await api.get('/sales/returns', { query: { partyId, view: 'all' }, schema: z.object({ returns: z.array(docOption) }), signal })
  return answer.returns
}

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type StyleOption = z.infer<typeof styleOption>

/** The styles a complaint may name (product.styles.view). */
export async function listStyles(api: ApiClient, signal?: AbortSignal): Promise<StyleOption[]> {
  const answer = await api.get('/product/styles', { query: { status: 'ALL', limit: 200 }, schema: z.object({ styles: z.array(styleOption) }), signal })
  return answer.styles
}

const siteOption = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() })
export type SiteOption = z.infer<typeof siteOption>

/** The company's sites (inventory.locations.view): where an NCR is followed, where a repair is made. */
export async function listSites(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<SiteOption[]> {
  const answer = await api.get('/inventory/locations', { schema: z.object({ sites: z.array(siteOption) }), signal })
  return answer.sites.filter((site) => site.companyId === companyId).sort((a, b) => a.code.localeCompare(b.code))
}

// ---- photos (the generic files routes, record type Complaint) -------------------------------------------------------------

const fileRow = z.object({ id: z.string(), kind: z.string(), originalName: z.string(), status: z.string(), contentType: z.string().optional() })
export type PhotoFile = z.infer<typeof fileRow>

/** The complaint's photos that may be shown (files.read). */
export async function listPhotos(api: ApiClient, complaintId: string, signal?: AbortSignal): Promise<PhotoFile[]> {
  const answer = await api.get('/files', { query: { recordType: 'Complaint', recordId: complaintId }, schema: z.object({ files: z.array(fileRow) }), signal })
  return answer.files.filter((file) => file.kind === 'PHOTO' && file.status === 'AVAILABLE')
}

/** A photo's address for an <img> (a presigned GET of 60 seconds; a same-origin path goes through this app's /api). */
export async function photoAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: z.object({ url: z.string() }) }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

/** One photo of the customer's onto the complaint (files.upload): announce, send the bytes, confirm. Office only. */
export async function uploadPhoto(api: ApiClient, complaint: { id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: complaint.companyId,
    record: { type: 'Complaint', id: complaint.id },
    kind: 'PHOTO',
    name: file.name || 'photo.jpg',
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
