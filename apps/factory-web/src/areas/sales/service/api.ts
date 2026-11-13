import { z } from 'zod'
import { REPAIR_KINDS, type RepairKind } from '@nexus/factory-domain/sales/repairs/rules'
import {
  BUYER_KINDS,
  CASE_ACTIONS,
  CASE_CHANNELS,
  CASE_KINDS,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CASE_VIEWS,
  CASE_WISHES,
  COVER_DECISIONS,
  COVER_STATES,
  COVERS,
  GUARANTEE_STATES,
  HELD_CODES,
  type CaseKind,
  type CasePriority,
  type CaseView,
  type CaseWish,
  type Cover,
  type CoverDecision,
  type CoverState,
  type LinkRecordType,
  type MoveTarget,
  type ReturnPurpose,
} from '@nexus/factory-domain/sales/service/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'

/**
 * Every call of Sales › After-sales › Warranty & service (SCR-217, SCR-413; B-W2b-345's routes, `apps/factory-api`
 * modules/sales/service): the list and its tiles, the owners, New case's preview and its create, the case and its writes
 * (facts, the cover decided, a move with its status mail, links, a repair or a return opened from it), and the pickers —
 * the customers and their contacts, the return reasons, the records a case may name by hand. Each answer is checked with
 * zod; the API's English words (the warranty check's `words`, `remedies`, `liable`, refusals, `next`) are never shown: the
 * screens say their own from the codes and dates.
 */

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

export { newIdempotencyKey }
export type { CaseKind, CasePriority, CaseView, CaseWish, Cover, CoverDecision, CoverState, LinkRecordType, MoveTarget, RepairKind, ReturnPurpose }
export type CaseStatus = (typeof CASE_STATUSES)[number]
export type CaseChannel = (typeof CASE_CHANNELS)[number]
export type CaseAction = (typeof CASE_ACTIONS)[number]
export type HeldCode = (typeof HELD_CODES)[number]

const person = z.object({ id: z.string(), name: z.string() })
export type Person = z.infer<typeof person>
const party = z.object({ id: z.string(), code: z.string(), legalName: z.string() })
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })
const issue = z.object({ path: z.string(), message: z.string() })
export type Issue = z.infer<typeof issue>

export const caseRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  kind: z.enum(CASE_KINDS),
  channel: z.enum(CASE_CHANNELS),
  status: z.enum(CASE_STATUSES),
  priority: z.enum(CASE_PRIORITIES),
  party: party.nullable(),
  serial: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  style: style.nullable(),
  size: z.string().nullable(),
  customerWants: z.enum(CASE_WISHES).nullable(),
  cover: z.object({ state: z.enum(COVER_STATES), decided: z.boolean(), decision: z.enum(COVER_DECISIONS).nullable() }),
  openedAt: z.string(),
  ownerId: z.string().nullable(),
  notifyCustomer: z.boolean(),
  links: z.number(),
  summary: z.string(),
  version: z.number(),
})
export type CaseRow = z.infer<typeof caseRowSchema>

const reading = z.object({ state: z.enum(GUARANTEE_STATES), endsOn: z.string().nullable(), daysLeft: z.number().nullable(), words: z.string() })
export const warrantyCheckSchema = z.object({
  buyer: z.enum(BUYER_KINDS),
  deliveredOn: z.string().nullable(),
  legal: reading,
  factory: reading,
  presumption: z.object({ applies: z.boolean(), until: z.string().nullable(), words: z.string() }).nullable(),
  suggested: z.enum(COVERS).nullable(),
  state: z.enum(COVER_STATES),
  remedies: z.string(),
  liable: z.string(),
  words: z.array(z.string()),
})
export type WarrantyCheck = z.infer<typeof warrantyCheckSchema>

const shipmentRef = z.object({ id: z.string(), number: z.string(), partyId: z.string(), day: z.string().nullable(), delivered: z.boolean() })
export const garmentSchema = z.object({
  serial: z
    .object({
      serial: z.string(),
      madeOn: z.string(),
      workOrderNumber: z.string(),
      batchNumber: z.string().nullable(),
      madeForPartyId: z.string().nullable(),
      salesOrderId: z.string().nullable(),
      shipment: shipmentRef.nullable(),
    })
    .nullable(),
  batch: z.object({ batchNumber: z.string(), workOrderNumber: z.string(), deliveries: z.array(shipmentRef) }).nullable(),
})
export type Garment = z.infer<typeof garmentSchema>

const linkSchema = z.object({
  id: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  record: z.object({ label: z.string(), status: z.string().nullable() }).nullable(),
})
export type CaseLink = z.infer<typeof linkSchema>

const mailSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  to: z.array(z.string()),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  sentById: z.string().nullable(),
})
export type CaseMail = z.infer<typeof mailSchema>

export const caseViewSchema = caseRowSchema.extend({
  party: z.object({ id: z.string(), code: z.string(), legalName: z.string(), kind: z.string() }).nullable(),
  contact: z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), language: z.string().nullable() }).nullable(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
  colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  problem: z.string(),
  garment: garmentSchema,
  warranty: z.object({
    deliveredOn: z.string().nullable(),
    legalGuaranteeEndsOn: z.string().nullable(),
    factoryGuaranteeEndsOn: z.string().nullable(),
    suggestedDeliveredOn: z.string().nullable(),
    check: warrantyCheckSchema,
    decided: z.object({ cover: z.enum(COVERS), decision: z.enum(COVER_DECISIONS), note: z.string(), at: z.string(), byId: z.string().nullable(), remedies: z.string() }).nullable(),
  }),
  resolution: z.object({ at: z.string(), words: z.string() }).nullable(),
  closed: z.object({ at: z.string(), byId: z.string().nullable(), reason: z.string().nullable() }).nullable(),
  internalNote: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  links: z.array(linkSchema),
  mails: z.array(mailSchema),
  actions: z.array(z.object({ action: z.enum(CASE_ACTIONS), allowed: z.boolean(), held: z.enum(HELD_CODES).nullable() })),
  people: z.array(person),
})
export type CaseRecord = z.infer<typeof caseViewSchema>

const oneCase = z.object({ case: caseViewSchema })
const withWarnings = z.object({ case: caseViewSchema, warnings: z.array(issue) })
export type WithWarnings = z.infer<typeof withWarnings>

// ---- the list and its tiles ------------------------------------------------------------------------------------------------

export interface CaseQuery {
  view: CaseView
  kind: CaseKind | null
  cover: CoverState | null
  serial: string
  q: string
}

const listAnswer = z.object({ cases: z.array(caseRowSchema), nextCursor: z.string().nullable(), people: z.array(person), asOf: z.string() })
export type CasePage = z.infer<typeof listAnswer>

/** GET /sales/service/cases: one page (200 at most; `nextCursor` names the next), newest first. */
export const listCases = (api: ApiClient, query: CaseQuery, cursor: string | null, signal?: AbortSignal): Promise<CasePage> =>
  api.get('/sales/service/cases', {
    query: clean({ view: (CASE_VIEWS as readonly string[]).includes(query.view) ? query.view : 'open', kind: query.kind, cover: query.cover, serial: query.serial.trim().slice(0, 100), q: query.q.trim().slice(0, 100), cursor, limit: 200 }),
    schema: listAnswer,
    signal,
  })

const countsAnswer = z.object({
  tiles: z.object({ new: z.number(), waitingCustomer: z.number(), waitingPart: z.number() }),
  rows: z.object({ open: z.number(), mine: z.number(), waiting: z.number(), closed: z.number(), all: z.number() }),
  asOf: z.string(),
})
export type CaseCounts = z.infer<typeof countsAnswer>
export const caseCounts = (api: ApiClient, signal?: AbortSignal): Promise<CaseCounts> => api.get('/sales/service/cases/counts', { schema: countsAnswer, signal })

/** Who may own a case of the company (sales.service.manage there). */
export const caseOwners = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<Person[]> =>
  api.get('/sales/service/cases/people', { query: { companyId }, schema: z.object({ owners: z.array(person) }), signal }).then((answer) => answer.owners)

// ---- New case ---------------------------------------------------------------------------------------------------------------

export interface OpenBody {
  companyId: string
  kind: CaseKind
  channel: 'OFFICE' | 'MAIL' | 'PHONE'
  partyId?: string | null
  contactId?: string | null
  serial?: string | null
  batchNumber?: string | null
  size?: string | null
  problem: string
  customerWants?: CaseWish | null
  priority?: CasePriority
  ownerId?: string | null
  deliveredOn?: string | null
  factoryGuaranteeEndsOn?: string | null
  notifyCustomer?: boolean
}

const previewAnswer = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  warnings: z.array(issue),
  draft: z.object({
    styleId: z.string().nullable(),
    colourwayId: z.string().nullable(),
    size: z.string().nullable(),
    batchNumber: z.string().nullable(),
    garmentSerial: z.string().nullable(),
    garmentBatch: z.string().nullable(),
    partyId: z.string().nullable(),
    deliveredOn: z.string().nullable(),
    legalGuaranteeEndsOn: z.string().nullable(),
    factoryGuaranteeEndsOn: z.string().nullable(),
  }),
  garment: garmentSchema,
  warranty: warrantyCheckSchema,
  others: z.array(z.object({ id: z.string(), number: z.string(), status: z.enum(CASE_STATUSES), kind: z.enum(CASE_KINDS), openedAt: z.string() })),
})
export type CasePreview = z.infer<typeof previewAnswer>

/** POST /sales/service/cases/preview: what the serial, the batch and the customer give the case. Writes nothing. */
export const previewCase = (api: ApiClient, body: Partial<OpenBody>, signal?: AbortSignal): Promise<CasePreview> => api.post('/sales/service/cases/preview', { body, schema: previewAnswer, signal })

export const openCase = (api: ApiClient, body: OpenBody, idempotencyKey: string): Promise<WithWarnings> => api.post('/sales/service/cases', { body, schema: withWarnings, idempotencyKey })

// ---- the case and its writes ---------------------------------------------------------------------------------------------------

export const getCase = (api: ApiClient, caseId: string, signal?: AbortSignal): Promise<CaseRecord> => api.get(`/sales/service/cases/${seg(caseId)}`, { schema: oneCase, signal }).then((answer) => answer.case)

export interface ChangeBody {
  version: number
  kind?: CaseKind
  partyId?: string | null
  contactId?: string | null
  serial?: string | null
  batchNumber?: string | null
  size?: string | null
  problem?: string
  customerWants?: CaseWish | null
  priority?: CasePriority
  ownerId?: string | null
  deliveredOn?: string | null
  legalGuaranteeEndsOn?: string | null
  factoryGuaranteeEndsOn?: string | null
  notifyCustomer?: boolean
  internalNote?: string | null
}
export const changeCase = (api: ApiClient, caseId: string, body: ChangeBody, idempotencyKey: string): Promise<WithWarnings> =>
  api.request('PATCH', `/sales/service/cases/${seg(caseId)}`, { body, schema: withWarnings, idempotencyKey })

export const decideCover = (api: ApiClient, caseId: string, body: { version: number; cover: Cover; decision: CoverDecision; note: string }, idempotencyKey: string): Promise<WithWarnings> =>
  api.post(`/sales/service/cases/${seg(caseId)}/cover`, { body, schema: withWarnings, idempotencyKey })

const notified = z.union([
  z.object({ sent: z.literal(true), emailId: z.string(), to: z.string(), subject: z.string() }),
  z.object({ sent: z.literal(false), reason: z.enum(['NO_CONTACT_EMAIL', 'NOT_SENT']), words: z.string() }),
])
const movedAnswer = z.object({ case: caseViewSchema, notified: notified.nullable(), warnings: z.array(issue) })
export type Moved = z.infer<typeof movedAnswer>
export interface MoveBody {
  version: number
  to: MoveTarget
  resolution?: string | null
  reason?: string | null
  message?: string | null
}
export const moveCase = (api: ApiClient, caseId: string, body: MoveBody, idempotencyKey: string): Promise<Moved> => api.post(`/sales/service/cases/${seg(caseId)}/status`, { body, schema: movedAnswer, idempotencyKey })

export const linkRecord = (api: ApiClient, caseId: string, body: { version: number; recordType: LinkRecordType; recordId: string; note?: string | null }, idempotencyKey: string): Promise<CaseRecord> =>
  api.post(`/sales/service/cases/${seg(caseId)}/links`, { body, schema: oneCase, idempotencyKey }).then((answer) => answer.case)

export const unlinkRecord = (api: ApiClient, caseId: string, linkId: string, version: number): Promise<CaseRecord> =>
  api.request('DELETE', `/sales/service/cases/${seg(caseId)}/links/${seg(linkId)}`, { query: { version }, schema: oneCase, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.case)

export interface RepairBody {
  version: number
  kind?: RepairKind
  problem?: string
  workWanted?: string | null
  received?: Record<string, never> | null
}
const madeRepair = z.object({ case: caseViewSchema, repair: z.object({ id: z.string(), number: z.string() }), warnings: z.array(issue) })
export const makeRepair = (api: ApiClient, caseId: string, body: RepairBody, idempotencyKey: string) => api.post(`/sales/service/cases/${seg(caseId)}/repair`, { body, schema: madeRepair, idempotencyKey })

export interface ReturnBody {
  version: number
  purpose: ReturnPurpose
  reasonCode: string
  fit?: string
  customerRef?: string | null
  goodsDueBy?: string | null
}
const madeReturn = z.object({ case: caseViewSchema, return: z.object({ id: z.string(), number: z.string() }), next: z.string(), warnings: z.array(issue) })
export const makeReturn = (api: ApiClient, caseId: string, body: ReturnBody, idempotencyKey: string) => api.post(`/sales/service/cases/${seg(caseId)}/return`, { body, schema: madeReturn, idempotencyKey })

export { REPAIR_KINDS }

// ---- pickers: customers and contacts, return reasons, records to link -------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** The customers and brands a case may be for (parties.view): the first 200 active ones. */
export const listCustomers = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> =>
  api.get('/parties', { query: clean({ role: 'CUSTOMER,BRAND', status: 'ACTIVE', companyId, limit: 200 }), schema: z.object({ parties: z.array(partyOption) }), signal }).then((answer) => answer.parties)

const contactOption = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), status: z.string() })
export type ContactOption = z.infer<typeof contactOption>

/** A customer's active contacts (the case's contact: the status mails go to them). */
export const listContacts = (api: ApiClient, partyId: string, signal?: AbortSignal): Promise<ContactOption[]> =>
  api.get(`/parties/${seg(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactOption) }) }), signal }).then((answer) => answer.party.contacts.filter((contact) => contact.status === 'ACTIVE'))

const reasonOption = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type ReasonOption = z.infer<typeof reasonOption>
/** The active return reasons (B-W2a-18: signed in, no permission). */
export const listReturnReasons = (api: ApiClient, signal?: AbortSignal): Promise<ReasonOption[]> =>
  api.get('/reasons', { query: { list: 'RETURN' }, schema: z.object({ reasons: z.array(reasonOption) }), signal }).then((answer) => answer.reasons)

/** A record the case may name, found by its number. */
export interface LinkCandidate {
  readonly recordType: LinkRecordType
  readonly recordId: string
  readonly number: string
  readonly title: string | null
}

const numbered = (key: string) => z.object({ [key]: z.array(z.object({ id: z.string(), number: z.string(), partyName: z.string().nullish(), party: z.object({ legalName: z.string() }).nullish() })) })
const searchAnswer = z.object({ results: z.array(z.object({ recordType: z.string(), recordId: z.string(), number: z.string().nullable(), title: z.string() })) })

/** The module lists that search their numbers on the server (`q`), by record type; the others go through the global search. */
const LIST_FINDERS: Partial<Record<LinkRecordType, { path: string; key: string }>> = {
  SalesOrder: { path: '/sales/orders', key: 'orders' },
  ReturnAuthorisation: { path: '/sales/returns', key: 'returns' },
  RepairOrder: { path: '/sales/repairs', key: 'repairs' },
}

/**
 * The records of one type whose number matches what was typed: the order, return and repair lists search on the server
 * (`q`, the case's customer when it has one); shipments, invoices, complaints and work orders through the global search
 * (its index is the worker's). A finder the person may not use (403) finds nothing.
 */
export async function findLinkable(api: ApiClient, recordType: LinkRecordType, q: string, partyId: string | null, signal?: AbortSignal): Promise<LinkCandidate[]> {
  const words = q.trim().slice(0, 60)
  try {
    const list = LIST_FINDERS[recordType]
    if (list) {
      // The order list pages (`limit`); the return and repair lists take a saved row (`view`) and no limit.
      const query = recordType === 'SalesOrder' ? { q: words, partyId, limit: 20 } : { q: words, partyId, view: 'all' }
      const answer = (await api.get(list.path, { query: clean(query), schema: numbered(list.key), signal })) as Record<string, { id: string; number: string; partyName?: string | null; party?: { legalName: string } | null }[]>
      return (answer[list.key] ?? []).slice(0, 20).map((row) => ({ recordType, recordId: row.id, number: row.number, title: row.partyName ?? row.party?.legalName ?? null }))
    }
    if (words.length < 2) return []
    const answer = await api.get('/search', { query: { q: words, type: recordType, limit: 20 }, schema: searchAnswer, signal })
    return answer.results.filter((hit) => hit.recordType === recordType).map((hit) => ({ recordType, recordId: hit.recordId, number: hit.number ?? hit.title, title: hit.number ? hit.title : null }))
  } catch (error) {
    if (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'not_found')) return []
    throw error
  }
}
