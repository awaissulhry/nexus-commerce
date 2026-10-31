import { answerDueState, COMPLAINT_LIMITS, COMPLAINT_TILES, type ComplaintTile } from '@nexus/factory-domain/quality/complaints/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Complaint, ComplaintAction, ComplaintCategory, ComplaintLinkType, ComplaintQuery, ComplaintRow, ComplaintSeverity, ComplaintStatus, ComplaintView, HeldCode, LogBody, LogPreview, OfficeChannel } from './api'
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES, COMPLAINT_VIEWS } from './api'

/**
 * The pure rules of Quality › Complaints (SCR-113 W2a part; B-W2a-65): what a person may do here, the list's address ⇄
 * the API's own filters, the tiles, the words and tones of a status, a category and a severity, the answer due in words,
 * each step held with its reason (the API's held codes, put in our words), the Log and Triage drafts with their checks,
 * a refusal of the API in our words, and the CSV of a view. No React, no API client.
 */

export { COMPLAINT_TILES, type ComplaintTile }

// ---- what a person may do ------------------------------------------------------------------------------------------------

export const COMPLAINT_PERMISSIONS = {
  view: 'quality.complaints.view',
  log: 'quality.complaints.log',
  manage: 'quality.complaints.manage',
  acknowledge: 'quality.complaints.acknowledge',
  registerView: 'compliance.register.view',
  registerManage: 'compliance.register.manage',
  ncrView: 'quality.ncr.view',
  ncrRaise: 'quality.ncr.raise',
  /** B-W2b-17: unlinking an NCR from the complaint. */
  ncrManage: 'quality.ncr.manage',
  repairsView: 'sales.repairs.view',
  repairsManage: 'sales.repairs.manage',
  partiesView: 'parties.view',
  ordersView: 'orders.view',
  shippingView: 'shipping.view',
  returnsView: 'sales.returns.view',
  stylesView: 'product.styles.view',
  /** B-W2b-17: Link… finds a garment by its serial (the evidence trail's read, else the label scan). */
  inspectionsView: 'quality.inspections.view',
  serialsScan: 'production.serials',
  sitesView: 'inventory.locations.view',
  filesRead: 'files.read',
  filesUpload: 'files.upload',
  threadsRead: 'threads.read',
  /** The price grain: the order's value. */
  price: 'money.price',
} as const

export type ComplaintAbility = keyof typeof COMPLAINT_PERMISSIONS
export type ComplaintsCan = Readonly<Record<ComplaintAbility, boolean>>

export function complaintsCan(permissions: readonly string[]): ComplaintsCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(COMPLAINT_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as ComplaintsCan
}

// ---- the list's address ----------------------------------------------------------------------------------------------------

export interface ComplaintsAddress {
  readonly view: ComplaintView
  readonly q: string
  readonly category: ComplaintCategory | null
  readonly severity: ComplaintSeverity | null
  /** "Mine": complaints I follow up. */
  readonly mine: boolean
  /** The API's own filters a link carries (a customer's, an order's, a shipment's, a return's complaints). */
  readonly partyId: string | null
  readonly salesOrderId: string | null
  readonly shipmentId: string | null
  readonly returnId: string | null
  /** The complaint open in the triage DetailModal. */
  readonly open: string | null
  /** Log complaint is open. */
  readonly log: boolean
}

export const DEFAULT_VIEW: ComplaintView = 'open'

const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null)

/** The page's state from its address (`?view=` a tile or row, `?q=`, `?category=`, `?severity=`, `?owner=me`, the API's ids, `?open=`, `?new=1`). */
export function addressOf(params: Pick<URLSearchParams, 'get'> | null): ComplaintsAddress {
  const get = (name: string) => params?.get(name) ?? null
  return {
    view: pick(get('view'), COMPLAINT_VIEWS) ?? DEFAULT_VIEW,
    q: get('q') ?? '',
    category: pick(get('category'), COMPLAINT_CATEGORIES),
    severity: pick(get('severity'), COMPLAINT_SEVERITIES),
    mine: get('owner') === 'me',
    partyId: get('partyId'),
    salesOrderId: get('salesOrderId'),
    shipmentId: get('shipmentId'),
    returnId: get('returnId'),
    open: get('open'),
    log: get('new') === '1',
  }
}

/** The address of a state (the default view and empty terms are left out). */
export function addressText(address: ComplaintsAddress): string {
  const search = new URLSearchParams()
  if (address.view !== DEFAULT_VIEW) search.set('view', address.view)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.category) search.set('category', address.category)
  if (address.severity) search.set('severity', address.severity)
  if (address.mine) search.set('owner', 'me')
  for (const name of ['partyId', 'salesOrderId', 'shipmentId', 'returnId'] as const) if (address[name]) search.set(name, address[name]!)
  if (address.open) search.set('open', address.open)
  if (address.log) search.set('new', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The API's query of a state. */
export function queryOf(address: ComplaintsAddress, limit: number, cursor: string | null = null): ComplaintQuery {
  return {
    view: address.view,
    q: address.q.trim() || null,
    category: address.category,
    severity: address.severity,
    owner: address.mine ? 'me' : null,
    partyId: address.partyId,
    salesOrderId: address.salesOrderId,
    shipmentId: address.shipmentId,
    returnId: address.returnId,
    cursor,
    limit,
  }
}

/** The list is narrower than every open complaint (a chip shows, "Clear filters" brings it back). */
export const isFiltered = (address: ComplaintsAddress): boolean =>
  address.view !== DEFAULT_VIEW || address.q.trim() !== '' || address.category !== null || address.severity !== null || address.mine || !!(address.partyId || address.salesOrderId || address.shipmentId || address.returnId)

export const PAGE = 50
/** The triage queue reads at most this many new complaints. */
export const QUEUE = 200

// ---- words and tones ---------------------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const STATUS_TONE: Readonly<Record<ComplaintStatus, Tone>> = { NEW: 'warning', TRIAGED: 'info', INVESTIGATING: 'info', ANSWERED: 'success', CLOSED: 'neutral' }
export const CATEGORY_TONE: Readonly<Record<ComplaintCategory, Tone>> = { SAFETY: 'danger', FUNCTION: 'warning', COSMETIC: 'neutral', FIT: 'neutral' }
export const SEVERITY_TONE: Readonly<Record<ComplaintSeverity, Tone>> = { CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'neutral' }

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const dayMs = 86_400_000
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / dayMs

/** Today's business day in Rome (the API's days are Rome's). */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** A business day as an instant the formatters read (midday UTC: the same day in Rome). */
export const dayAt = (day: string): string => `${day}T12:00:00.000Z`

/**
 * A day picked in a dialog as the instant the API takes: today → now (a later hour would be "in the future"), another
 * day → 10:00 UTC of that day (around midday in Rome, inside its business day).
 */
export function dayInstant(day: string, today: string, now: Date = new Date()): string | undefined {
  if (!day) return undefined
  if (day === today) return now.toISOString()
  return `${day}T10:00:00.000Z`
}

/** The answer due, in words and a tone: overdue (by n days), today, in n days, or a later day; nothing once answered. */
export function answerDueWords(row: Pick<ComplaintRow, 'status' | 'answerDueOn'>, today: string): { words: Words; tone: Tone } | null {
  if (!row.answerDueOn) return null
  const state = answerDueState(row.status, row.answerDueOn, today)
  const days = dayNumber(row.answerDueOn) - dayNumber(today)
  if (state === 'NONE') return { words: { key: 'due.set' }, tone: 'neutral' }
  if (state === 'OVERDUE') return { words: { key: 'due.overdue', params: { count: -days } }, tone: 'danger' }
  if (days === 0) return { words: { key: 'due.today' }, tone: 'warning' }
  if (state === 'SOON') return { words: { key: 'due.inDays', params: { count: days } }, tone: 'warning' }
  return { words: { key: 'due.inDays', params: { count: days } }, tone: 'neutral' }
}

/** What the garment is, as reported: its serial, else its batch, else nothing. */
export function garmentWords(row: Pick<ComplaintRow, 'serial' | 'batchNumber'>): Words | null {
  if (row.serial) return { key: 'garment.serial', params: { serial: row.serial } }
  if (row.batchNumber) return { key: 'garment.batch', params: { batch: row.batchNumber } }
  return null
}

/** The evidence trail of the garment (a new tab, W1's page): its serial, else its batch. */
export function evidenceHref(prefix: string, evidence: Complaint['evidence']): string | null {
  if (!evidence) return null
  return `${prefix}/compliance/evidence/${evidence.kind}/${encodeURIComponent(evidence.subject)}`
}

export const recordHref = (prefix: string, id: string, tab?: string): string => `${prefix}/quality/complaints/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`

/** The office person's name by id from an answer's `people`, else "—". */
export const personName = (people: readonly { id: string; name: string }[], id: string | null): string | null => (id ? (people.find((person) => person.id === id)?.name ?? null) : null)

// ---- each step, held with its reason ----------------------------------------------------------------------------------------

export interface StepState {
  readonly allowed: boolean
  /** A message key of `complaints` (why it is held), or null. */
  readonly held: string | null
}

/** The message key of a held code for a step: a missing permission names the step's own. */
export function heldKey(action: ComplaintAction, code: HeldCode | null): string | null {
  if (code === null) return null
  return code === 'NO_PERMISSION' ? `held.NO_PERMISSION.${action}` : `held.${code}`
}

/** A step of the record as the API decided it (its held code in our words). */
export function stepOf(complaint: Pick<Complaint, 'actions'>, action: ComplaintAction, offline = false): StepState {
  const found = complaint.actions.find((entry) => entry.action === action)
  if (!found) return { allowed: false, held: `held.NO_PERMISSION.${action}` }
  if (found.allowed && offline) return { allowed: false, held: 'held.offline' }
  return { allowed: found.allowed, held: heldKey(action, found.held) }
}

/** The band's primary step by status: Triage when new, Start investigation, Mark answered, Close; none once closed. */
export function primaryAction(status: ComplaintStatus): ComplaintAction | null {
  switch (status) {
    case 'NEW':
      return 'triage'
    case 'TRIAGED':
      return 'startInvestigation'
    case 'INVESTIGATING':
      return 'markAnswered'
    case 'ANSWERED':
      return 'close'
    default:
      return null
  }
}

/** A step on a list row (no record read yet): the permission first, then what the row's status says. */
export function rowStep(row: Pick<ComplaintRow, 'status' | 'register' | 'style'>, action: 'triage' | 'register' | 'createNcr', can: ComplaintsCan): StepState {
  if (action === 'triage') {
    if (!can.manage) return { allowed: false, held: 'held.NO_PERMISSION.triage' }
    return row.status === 'CLOSED' ? { allowed: false, held: 'held.CLOSED' } : { allowed: true, held: null }
  }
  if (action === 'register') {
    if (!can.manage || !can.registerManage) return { allowed: false, held: 'held.NO_PERMISSION.register' }
    if (row.status === 'CLOSED') return { allowed: false, held: 'held.CLOSED' }
    if (row.register) return { allowed: false, held: 'held.IN_REGISTER' }
    return row.style ? { allowed: true, held: null } : { allowed: false, held: 'held.NO_STYLE' }
  }
  if (!can.ncrRaise) return { allowed: false, held: 'held.NO_PERMISSION.createNcr' }
  return row.status === 'CLOSED' ? { allowed: false, held: 'held.CLOSED' } : { allowed: true, held: null }
}

// ---- the triage draft --------------------------------------------------------------------------------------------------------

export interface TriageDraft {
  readonly category: ComplaintCategory | null
  readonly severity: ComplaintSeverity | null
  readonly ownerId: string
  readonly answerDueOn: string
  /** The garment's style, when the complaint names none (required for a safety complaint). */
  readonly styleId: string
  readonly risk: 'ASSESSING' | 'YES'
  readonly note: string
}

/** The draft a complaint opens with: its own triage when it has one, else the suggested answer day and me as the owner. */
export function triageDraftOf(complaint: Pick<Complaint, 'category' | 'severity' | 'ownerId' | 'answerDueOn' | 'suggestedAnswerDueOn' | 'style'>, me: string, owners: readonly { id: string }[] | null): TriageDraft {
  const mine = owners === null || owners.some((owner) => owner.id === me) ? me : ''
  return {
    category: complaint.category,
    severity: complaint.severity,
    ownerId: complaint.ownerId ?? mine,
    answerDueOn: complaint.answerDueOn ?? complaint.suggestedAnswerDueOn ?? '',
    styleId: complaint.style?.id ?? '',
    risk: 'ASSESSING',
    note: '',
  }
}

export type TriageField = 'category' | 'severity' | 'ownerId' | 'answerDueOn' | 'styleId' | 'note'

/** What still stops the triage, field by field (message keys of `complaints`), in the order of the form. */
export function triageProblems(draft: TriageDraft, complaint: Pick<Complaint, 'receivedAt' | 'style'>): { field: TriageField; key: string }[] {
  const problems: { field: TriageField; key: string }[] = []
  if (!draft.category) problems.push({ field: 'category', key: 'triage.problem.category' })
  if (!draft.severity) problems.push({ field: 'severity', key: 'triage.problem.severity' })
  if (!draft.ownerId) problems.push({ field: 'ownerId', key: 'triage.problem.owner' })
  if (!draft.answerDueOn) problems.push({ field: 'answerDueOn', key: 'triage.problem.answerDue' })
  else if (draft.answerDueOn < romeToday(new Date(complaint.receivedAt))) problems.push({ field: 'answerDueOn', key: 'triage.problem.answerDueBefore' })
  if (draft.category === 'SAFETY' && !complaint.style && !draft.styleId) problems.push({ field: 'styleId', key: 'triage.problem.style' })
  if (draft.note.trim().length > COMPLAINT_LIMITS.note) problems.push({ field: 'note', key: 'triage.problem.note' })
  return problems
}

/** A triage that raises the safety alert now (the first time a complaint is triaged Safety): it asks first. */
export const raisesSafety = (draft: TriageDraft, complaint: Pick<Complaint, 'safety'>): boolean => draft.category === 'SAFETY' && complaint.safety.state === 'NONE'

/** The next complaint of the queue after this one (else the one before), or null when it was the last. */
export function nextInQueue(ids: readonly string[], current: string): string | null {
  const at = ids.indexOf(current)
  if (at < 0) return ids[0] ?? null
  return ids[at + 1] ?? ids[at - 1] ?? null
}

// ---- the Log draft -------------------------------------------------------------------------------------------------------------

export interface LogDraft {
  readonly partyId: string
  readonly contactId: string
  readonly customerRef: string
  readonly channel: OfficeChannel
  /** The day it came in ('' = now). */
  readonly receivedOn: string
  readonly description: string
  readonly salesOrderId: string
  readonly shipmentId: string
  readonly returnId: string
  readonly styleId: string
  readonly size: string
  readonly serial: string
  readonly batchNumber: string
  readonly internalNote: string
  /** The customer's photos, sent once the complaint is logged. */
  readonly photos: readonly File[]
}

export const blankLogDraft = (today: string): LogDraft => ({
  partyId: '',
  contactId: '',
  customerRef: '',
  channel: 'EMAIL',
  receivedOn: today,
  description: '',
  salesOrderId: '',
  shipmentId: '',
  returnId: '',
  styleId: '',
  size: '',
  serial: '',
  batchNumber: '',
  internalNote: '',
  photos: [],
})

export type LogField = 'partyId' | 'description' | 'receivedOn' | 'customerRef' | 'size' | 'serial' | 'batchNumber' | 'internalNote' | 'photos'

export const PHOTO_MAX = 6
export const PHOTO_BYTES = 15 * 1024 * 1024

/** What still stops the log, field by field (message keys of `complaints`). */
export function logProblems(draft: LogDraft, today: string): { field: LogField; key: string }[] {
  const problems: { field: LogField; key: string }[] = []
  if (!draft.partyId) problems.push({ field: 'partyId', key: 'log.problem.customer' })
  if (!draft.description.trim()) problems.push({ field: 'description', key: 'log.problem.words' })
  else if (draft.description.trim().length > COMPLAINT_LIMITS.description) problems.push({ field: 'description', key: 'log.problem.wordsLong' })
  if (draft.receivedOn && draft.receivedOn > today) problems.push({ field: 'receivedOn', key: 'log.problem.future' })
  if (draft.customerRef.trim().length > COMPLAINT_LIMITS.customerRef) problems.push({ field: 'customerRef', key: 'log.problem.tooLong' })
  if (draft.serial.trim().length > COMPLAINT_LIMITS.serial) problems.push({ field: 'serial', key: 'log.problem.tooLong' })
  if (draft.batchNumber.trim().length > COMPLAINT_LIMITS.batchNumber) problems.push({ field: 'batchNumber', key: 'log.problem.tooLong' })
  if (draft.size.trim().length > COMPLAINT_LIMITS.size) problems.push({ field: 'size', key: 'log.problem.tooLong' })
  if (draft.internalNote.trim().length > COMPLAINT_LIMITS.internalNote) problems.push({ field: 'internalNote', key: 'log.problem.tooLong' })
  if (draft.photos.length > PHOTO_MAX) problems.push({ field: 'photos', key: 'log.problem.photoCount' })
  if (draft.photos.some((photo) => photo.size > PHOTO_BYTES || !photo.type.startsWith('image/'))) problems.push({ field: 'photos', key: 'log.problem.photoKind' })
  return problems
}

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The body the Log dialog sends (the company is the page's). */
export function logBody(draft: LogDraft, companyId: string, today: string, now: Date = new Date()): LogBody {
  const receivedAt = dayInstant(draft.receivedOn, today, now)
  return {
    companyId,
    partyId: draft.partyId,
    contactId: blankToNull(draft.contactId),
    customerRef: blankToNull(draft.customerRef),
    channel: draft.channel,
    ...(receivedAt ? { receivedAt } : {}),
    description: draft.description.trim(),
    salesOrderId: blankToNull(draft.salesOrderId),
    shipmentId: blankToNull(draft.shipmentId),
    returnId: blankToNull(draft.returnId),
    styleId: blankToNull(draft.styleId),
    size: blankToNull(draft.size),
    serial: blankToNull(draft.serial),
    batchNumber: blankToNull(draft.batchNumber),
    internalNote: blankToNull(draft.internalNote),
  }
}

/** What the preview found fills only what the person left empty (never over what they typed). */
export function withPreview(draft: LogDraft, preview: LogPreview): LogDraft {
  const found = preview.draft
  const fill = (mine: string, theirs: string | null) => (mine.trim() === '' && theirs ? theirs : mine)
  return {
    ...draft,
    partyId: fill(draft.partyId, found.partyId),
    styleId: fill(draft.styleId, found.styleId),
    size: fill(draft.size, found.size),
    batchNumber: fill(draft.batchNumber, found.batchNumber),
    shipmentId: fill(draft.shipmentId, found.shipmentId),
    salesOrderId: fill(draft.salesOrderId, found.salesOrderId),
  }
}

// ---- the API's refusals in our words -----------------------------------------------------------------------------------------

/**
 * A refused step in our words: a held code (409 `held/<CODE>`) → `held.<CODE>`; a stale version → `refusal.conflict`; a
 * field the API refused (`body/<field>`) → `refusal.field.<field>` when we have words for it; else the kind's words of
 * the shared `quality` catalogue (`quality:problem.<kind>`).
 */
export function refusalKey(error: unknown): string {
  if (!isApiError(error)) return 'quality:problem.unavailable'
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('held/')) return `held.${path.slice(5)}`
  }
  if (error.kind === 'conflict') return 'refusal.conflict'
  if (error.kind === 'invalid') {
    const field = error.issues.map((issue) => issuePath(issue)).find((path) => path.startsWith('body/'))
    if (field) {
      const name = field.slice(5).split('/')[0]!
      if (REFUSED_FIELDS.includes(name)) return `refusal.field.${name}`
    }
    return 'refusal.invalid'
  }
  if (error.kind === 'forbidden') return 'quality:problem.forbidden'
  if (error.kind === 'not_found') return 'quality:problem.notFound'
  if (error.kind === 'signed_out') return 'quality:problem.signedOut'
  if (error.kind === 'rate_limited') return 'quality:problem.rateLimited'
  if (error.kind === 'contract') return 'quality:problem.contract'
  if (error.kind === 'unavailable') return 'quality:problem.unavailable'
  return 'quality:problem.internal'
}

const REFUSED_FIELDS = ['styleId', 'answerDueOn', 'ownerId', 'description', 'receivedAt', 'partyId', 'shipmentId', 'salesOrderId', 'returnId', 'reason', 'siteId', 'serial']

/** Whether a refusal is a stale version (the record is read again). */
export const isStale = (error: unknown): boolean => isApiError(error) && error.kind === 'conflict' && !error.issues.some((issue) => issuePath(issue).startsWith('held/'))

// ---- the CSV of a view -------------------------------------------------------------------------------------------------------

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

function csvLine(values: readonly (string | number | null | undefined)[]): string {
  return values
    .map((value) => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

/** "This view (CSV)" / "Export N": one line per complaint in the person's language; the order's value only with the price grain. */
export function complaintsCsv(rows: readonly ComplaintRow[], people: readonly { id: string; name: string }[], t: Translate, price: boolean): string {
  const columns = ['number', 'received', 'channel', 'customer', 'customerRef', 'order', 'shipment', 'style', 'size', 'serial', 'batch', 'category', 'severity', 'status', 'owner', 'answerDue', 'ncr', 'register', ...(price ? ['orderValue', 'currency'] : [])]
  const head = csvLine(columns.map((column) => t(`csv.${column}`)))
  const lines = rows.map((row) =>
    csvLine([
      row.number,
      row.receivedAt.slice(0, 10),
      t(`channel.${row.channel}`),
      row.party.legalName,
      row.customerRef,
      row.order?.number,
      row.shipment?.number,
      row.style?.code,
      row.size,
      row.serial,
      row.batchNumber,
      row.category ? t(`category.${row.category}`) : '',
      row.severity ? t(`severity.${row.severity}`) : '',
      t(`status.${row.status}`),
      personName(people, row.ownerId),
      row.answerDueOn,
      row.ncrs.map((ncr) => ncr.number).join(' '),
      row.register?.reference,
      ...(price ? [row.order?.netAmount !== undefined ? (row.order.netAmount / 100).toFixed(2) : '', row.order?.currency] : []),
    ]),
  )
  return [head, ...lines].join('\r\n')
}

/** A safety alert's words on the banner: what the garment is (its style, its batch or serial). */
export function alertGarment(alert: { style: { code: string } | null; batchNumber: string | null; serial: string | null }): Words {
  const garment: { key: string; params: Record<string, string> } | null = alert.serial ? { key: 'banner.serial', params: { serial: alert.serial } } : alert.batchNumber ? { key: 'banner.batch', params: { batch: alert.batchNumber } } : null
  if (alert.style && garment) return { key: `${garment.key}Style`, params: { style: alert.style.code, ...garment.params } }
  if (alert.style) return { key: 'banner.style', params: { style: alert.style.code } }
  return garment ?? { key: 'banner.noGarment' }
}

// ---- B-W2b-17: Link… / Unlink on Linked records (design cmp-links) ----------------------------------------------------------

/** What Link… offers, in the design's order: the complaint's own facts, then an NCR. */
export const LINK_TYPES: readonly ComplaintLinkType[] = ['SalesOrder', 'Shipment', 'ReturnAuthorisation', 'GarmentSerial', 'Nonconformance']

/** Whether this person may change the complaint's links at all now (a message key of `complaints` when not). */
export function linksHeld(complaint: Pick<Complaint, 'status'>, can: ComplaintsCan, offline = false): string | null {
  if (complaint.status === 'CLOSED') return 'held.CLOSED'
  if (complaint.status === 'NEW' ? !can.log && !can.manage : !can.manage) return complaint.status === 'NEW' ? 'links.held.log' : 'links.held.manage'
  return offline ? 'held.offline' : null
}

/** Why a type cannot be linked by this person (a message key), or null: its finder's right, and for an NCR the raise. */
export function linkTypeHeld(type: ComplaintLinkType, can: ComplaintsCan): string | null {
  if (type === 'SalesOrder') return can.ordersView ? null : 'links.held.orders'
  if (type === 'Shipment') return can.shippingView ? null : 'links.held.shipments'
  if (type === 'ReturnAuthorisation') return can.returnsView ? null : 'links.held.returns'
  if (type === 'GarmentSerial') return can.inspectionsView || can.serialsScan ? null : 'links.held.garment'
  if (!can.ncrView) return 'links.held.ncrView'
  return can.ncrRaise ? null : 'links.held.ncrRaise'
}

/** The fact a type already names on the complaint (one each: a second is linked only after the first is unlinked). */
export function linkedFact(complaint: Pick<Complaint, 'order' | 'shipment' | 'return' | 'serial'>, type: Exclude<ComplaintLinkType, 'Nonconformance'>): string | null {
  if (type === 'SalesOrder') return complaint.order?.number ?? null
  if (type === 'Shipment') return complaint.shipment?.number ?? null
  if (type === 'ReturnAuthorisation') return complaint.return?.number ?? null
  return complaint.serial
}

/** Link…'s Save held with its reason (a message key and params), or null when it may go. */
export function linkSaveHeld(complaint: Pick<Complaint, 'order' | 'shipment' | 'return' | 'serial' | 'ncrs'>, draft: { readonly type: ComplaintLinkType | ''; readonly recordId: string; readonly serial: string }, can: ComplaintsCan): Words | null {
  if (!draft.type) return { key: 'links.problem.type' }
  const typeHeld = linkTypeHeld(draft.type, can)
  if (typeHeld) return { key: typeHeld }
  if (draft.type === 'GarmentSerial') {
    if (!draft.serial.trim()) return { key: 'links.problem.serial' }
    // The serial the complaint names already may be linked as our garment; another one waits for an unlink.
    const named = linkedFact(complaint, draft.type)
    return named && named.toUpperCase() !== draft.serial.trim().toUpperCase() ? { key: 'links.problem.taken', params: { label: named } } : null
  }
  if (draft.type !== 'Nonconformance') {
    const named = linkedFact(complaint, draft.type)
    if (named) return { key: 'links.problem.taken', params: { label: named } }
  }
  if (!draft.recordId) return { key: draft.type === 'Nonconformance' ? 'links.problem.ncr' : 'links.problem.record' }
  if (draft.type === 'Nonconformance' && complaint.ncrs.some((ncr) => ncr.id === draft.recordId)) return { key: 'links.problem.ncrLinked' }
  return null
}

/** Unlink of one linked record, held with its reason (a message key and params), or null. */
export function unlinkHeld(complaint: Pick<Complaint, 'status'>, type: ComplaintLinkType, can: ComplaintsCan, options: { readonly raisedFrom?: boolean; readonly offline?: boolean } = {}): string | null {
  const held = linksHeld(complaint, can, options.offline)
  if (held) return held
  if (type === 'Nonconformance') {
    if (options.raisedFrom) return 'links.held.source'
    if (!can.ncrManage) return 'links.held.ncrManage'
  }
  return null
}

/**
 * A refused link or unlink in our words: a stale version (409 with a `version` issue) → `refusal.conflict` (read again);
 * a closed complaint (409 invalid_state) → `held.CLOSED`; another 409 → the link's own refusal (already linked to
 * another one / the source NCR stays / the NCR names it already); 404 → not found (link) or not linked any more (unlink);
 * else the complaint's usual refusal words.
 */
export function linkRefusalKey(error: unknown, step: 'link' | 'unlink', type: ComplaintLinkType): string {
  if (!isApiError(error)) return 'quality:problem.unavailable'
  if (error.kind === 'conflict') {
    if (error.issues.some((issue) => issuePath(issue) === 'version')) return 'refusal.conflict'
    if (error.issues.some((issue) => issuePath(issue).startsWith('held/'))) return refusalKey(error)
    if (error.code === 'invalid_state') return 'held.CLOSED'
    if (step === 'unlink') return type === 'Nonconformance' ? 'links.refused.source' : 'links.refused.gone'
    return type === 'Nonconformance' ? 'links.refused.ncrTaken' : 'links.refused.taken'
  }
  if (error.kind === 'not_found') return step === 'unlink' ? 'links.refused.gone' : type === 'GarmentSerial' ? 'links.refused.garment' : 'links.refused.notFound'
  return refusalKey(error)
}

/** The words of a link type (Link…'s choice, a receipt). */
export const linkTypeKey = (type: ComplaintLinkType): string => `links.type.${type}`
