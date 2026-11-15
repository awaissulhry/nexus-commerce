import { DATA_REQUEST_KINDS, type DataRequestKind, type DataSubjectKind, type RequestHeld } from '@nexus/factory-domain/privacy/retention/requests'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { StepUpModel } from '../../shared/model'
import type { EraseModel } from '../erase/model'
import { csvOf, type Read } from '../model'
import type { DataRequest, PersonOption, RequestActionName, RequestList, RequestView } from './api'
import { REQUEST_VIEWS } from './api'

/**
 * Data requests, pure (B-W2b-414; design admin.privacy sec:requests "Person, kind (Access · Erasure · Correction), received,
 * due (Countdown), state" and h.act "New data request"): who may do what, the list's address, the clock's tone, each held
 * action's words from its code, the CSV for an auditor (never a name), and the New data request form's checks.
 */

export interface RequestsCan {
  /** privacy.requests.view: the requests name a person (the administrator's only, never the read-only role). */
  view: boolean
  /** privacy.requests.manage: record, check, extend, collect, close, refuse. */
  manage: boolean
  /** privacy.erase: anonymise a person (a fresh code every time). */
  erase: boolean
  /** The lists New data request reads to find the person, each with its own right. */
  lookup: Readonly<Record<DataSubjectKind, boolean>>
}

/** Which list finds a person of each kind, and the right it needs (said when it is missing). */
export const LOOKUP_PERMISSION: Readonly<Record<DataSubjectKind, string>> = Object.freeze({
  CONTACT: 'parties.view',
  PROSPECT: 'sales.inquiries.view',
  REPORTER: 'sales.safety.view',
  USER: 'users.view',
  WORKER: 'people.view',
})

export function requestsCan(permissions: readonly string[]): RequestsCan {
  const held = new Set(permissions)
  const lookup = Object.fromEntries(Object.entries(LOOKUP_PERMISSION).map(([kind, permission]) => [kind, held.has(permission)])) as Record<DataSubjectKind, boolean>
  return { view: held.has('privacy.requests.view'), manage: held.has('privacy.requests.manage'), erase: held.has('privacy.erase'), lookup }
}

/** The kinds of person, in the order the New data request form offers them. */
export const PERSON_KINDS: readonly DataSubjectKind[] = ['CONTACT', 'PROSPECT', 'REPORTER', 'USER', 'WORKER']
export const KIND_ORDER: readonly DataRequestKind[] = DATA_REQUEST_KINDS

// ---- the address ------------------------------------------------------------------------------------------------------------

/** The list's own terms in the page's address: `?view=requests&requests=open|closed|all&kind=&request=<id>&new=1`. */
export interface RequestsAddress {
  view: RequestView
  kind: DataRequestKind | null
  /** The request open in its dialog. */
  request: string | null
  /** New data request is open. */
  creating: boolean
}

export function requestsAddressOf(params: { get(name: string): string | null } | null | undefined): RequestsAddress {
  const view = params?.get('requests')
  const kind = params?.get('kind')
  return {
    view: REQUEST_VIEWS.includes(view as RequestView) ? (view as RequestView) : 'open',
    kind: KIND_ORDER.includes(kind as DataRequestKind) ? (kind as DataRequestKind) : null,
    request: params?.get('request') || null,
    creating: params?.get('new') === '1',
  }
}

/** The same address with some terms changed (the page's other terms kept). */
export function withRequestsAddress(query: string, change: Partial<RequestsAddress>): string {
  const next = new URLSearchParams(query)
  next.set('view', 'requests')
  const put = (name: string, value: string | null) => (value ? next.set(name, value) : next.delete(name))
  if (change.view !== undefined) put('requests', change.view === 'open' ? null : change.view)
  if (change.kind !== undefined) put('kind', change.kind)
  if (change.request !== undefined) put('request', change.request)
  if (change.creating !== undefined) put('new', change.creating ? '1' : null)
  return next.toString()
}

/** A request's own address (an audit row or a notification of a DataRequest opens it). */
export const requestHref = (prefix: string, requestId: string) => `${prefix}/admin/privacy?view=requests&request=${encodeURIComponent(requestId)}`

// ---- the clock and the state ----------------------------------------------------------------------------------------------

export type ClockTone = 'late' | 'soon' | 'ok' | 'closed'

/** Late (the due time in force passed), soon (3 days or less), in time, or closed (the clock stopped). */
export function clockTone(request: Pick<DataRequest, 'status' | 'overdue' | 'hoursLeft'>): ClockTone {
  if (request.status !== 'RECEIVED' && request.status !== 'IN_PROGRESS') return 'closed'
  if (request.overdue) return 'late'
  return request.hoursLeft <= 72 ? 'soon' : 'ok'
}

export const CLOCK_PILL = { late: 'danger', soon: 'warning', ok: 'neutral', closed: 'neutral' } as const
export const STATUS_PILL = { RECEIVED: 'info', IN_PROGRESS: 'warning', DONE: 'success', REFUSED: 'neutral', WITHDRAWN: 'neutral' } as const

/** A held action's words: `dp.held.<CODE>` (the API's English is never drawn). */
export const heldKey = (code: RequestHeld) => `dp.held.${code}`

/** Why an action is held, as a key, or null when it may be done (the right first, then the request's own state). */
export function actionHeld(request: DataRequest, action: RequestActionName, can: RequestsCan): string | null {
  const state = request.actions[action]
  if (action === 'openPackage') {
    if (!can.manage) return 'dp.req.held.manage'
  } else if (action === 'erase') {
    if (!can.erase) return 'dp.req.held.erase'
  } else if (!can.manage) return 'dp.req.held.manage'
  return state.allowed ? null : state.held ? heldKey(state.held.code) : 'dp.req.held.manage'
}

/** The person's name as the screen shows it: an erased person is said in the page's words. */
export const personErased = (request: Pick<DataRequest, 'person'>) => request.person.erased

/** The rows of the list, in the API's order (open by due time, then closed newest first), of one kind when asked. */
export function requestRows(list: RequestList | null, kind: DataRequestKind | null): DataRequest[] | null {
  if (!list) return null
  return kind ? list.requests.filter((row) => row.kind === kind) : [...list.requests]
}

/**
 * The selected requests as CSV for an auditor ("data requests answered within 30 days"): the clock and the outcome, the kind of
 * person and the record that names them — never a name (the export leaves the person's data where it is).
 */
export function requestsCsv(rows: readonly DataRequest[]): string {
  const header = ['company', 'kind', 'personKind', 'personRecord', 'received', 'due', 'extended', 'status', 'late', 'identityChecked', 'decided']
  return csvOf(
    header,
    rows.map((row) => [row.company.code, row.kind, row.person.kind, `${row.person.recordType}:${row.person.recordId}`, row.receivedAt, row.dueAt, row.extended ? 'yes' : 'no', row.status, row.overdue ? 'yes' : 'no', row.identityCheckedAt ?? '', row.decidedAt ?? '']),
  )
}

/** "1.2 MB": a package's size in the page's numbers. */
export function sizeWords(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** B-W2b-405's events: the data-protection sections read again on them (the page's own lists leave them alone). */
export const DEPTH_EVENTS = ['privacy.request_changed', 'privacy.request_collect_asked', 'privacy.person_erased', 'privacy.retention_rule_changed', 'privacy.retention_swept', 'privacy.safety_report_form_switched'] as const
export const isDepthEvent = (type: string): boolean => (DEPTH_EVENTS as readonly string[]).includes(type)
/** A request's own events (a change of state, its package, an erasure). */
export const isRequestEvent = (type: string): boolean => type === 'privacy.request_changed' || type === 'privacy.request_collect_asked' || type === 'privacy.person_erased'

// ---- problems ---------------------------------------------------------------------------------------------------------------

/** A failed read or write as a key of this page (the API's English is never drawn); an erasure blocked by its code. */
export function problemOf(error: unknown): string {
  if (!isApiError(error)) return 'dp.problem.failed'
  const blocked = error.issues.map(issuePath).find((path) => path.startsWith('privacy/'))
  if (blocked) return `dp.erase.blocked.${blocked.slice('privacy/'.length)}`
  switch (error.kind) {
    case 'forbidden':
      return 'dp.problem.forbidden'
    case 'not_found':
      return 'dp.problem.notFound'
    case 'conflict':
      return 'dp.problem.conflict'
    case 'invalid':
      return 'dp.problem.invalid'
    case 'rate_limited':
      return 'dp.problem.rateLimited'
    case 'unavailable':
      return 'dp.problem.unavailable'
    case 'step_up':
      return 'dp.problem.stepUp'
    default:
      return 'dp.problem.failed'
  }
}

// ---- New data request ------------------------------------------------------------------------------------------------------

export interface NewRequestDraft {
  companyId: string
  personKind: DataSubjectKind
  kind: DataRequestKind
  /** The search typed for the person (a customer's for a contact). */
  search: string
  /** CONTACT: the customer picked first. */
  partyId: string
  person: PersonOption | null
  /** When it came in, an ISO instant (default now): the 30-day clock starts there. */
  receivedAt: string
  note: string
}

export interface NewRequestModel {
  draft: NewRequestDraft
  /** The search's answer: the customers (CONTACT) or the people of the kind. */
  found: Read<PersonOption[]> | null
  /** CONTACT: the customer's contacts. */
  contacts: Read<PersonOption[]> | null
  busy: boolean
  problem: string | null
}

export const emptyDraft = (companyId: string, receivedAt: string): NewRequestDraft => ({ companyId, personKind: 'CONTACT', kind: 'ACCESS', search: '', partyId: '', person: null, receivedAt, note: '' })

/** Why Record the request is held (a key), or null. */
export function newRequestHeld(draft: NewRequestDraft, can: RequestsCan, now: string): string | null {
  if (!can.manage) return 'dp.req.held.manage'
  if (!draft.companyId) return 'dp.new.held.company'
  if (!draft.person) return 'dp.new.held.person'
  if (draft.person.companyId !== null && draft.person.companyId !== draft.companyId) return 'dp.new.held.otherCompany'
  if (!draft.receivedAt) return 'dp.new.held.received'
  if (Date.parse(draft.receivedAt) > Date.parse(now) + 5 * 60_000) return 'dp.new.held.future'
  if (draft.note.trim().length > 2000) return 'dp.new.held.note'
  return null
}

// ---- the section's one view model ------------------------------------------------------------------------------------------

/** A form inside the request's dialog (one at a time). */
export type RequestForm =
  | { name: 'identity'; how: string }
  | { name: 'extend'; months: 1 | 2; reason: string }
  | { name: 'refuse'; reason: string }
  | { name: 'withdraw'; reason: string }

export interface RequestDialogModel {
  requestId: string
  read: Read<DataRequest>
  form: RequestForm | null
  busy: boolean
  problem: string | null
  /** What the last step did, a key. */
  done: string | null
}

export interface Phrase {
  key: string
  params?: Record<string, string | number>
}

export interface RequestsViewModel {
  prefix: string
  can: RequestsCan
  address: RequestsAddress
  companyId: string | null
  /** The companies New data request may record in (the page's). */
  companies: readonly { id: string; name: string }[]
  list: Read<RequestList>
  selected: readonly string[]
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  /** The read's clock (ms): the countdowns start from it, so a server render matches the first client render. */
  now: number
  timeZone: string
  dialog: RequestDialogModel | null
  creating: NewRequestModel | null
  erase: EraseModel | null
  stepUp: StepUpModel
  notice: (Phrase & { tone: 'success' | 'warning' | 'danger' }) | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

/** The form's own check (a key), or null: how the identity was checked, a reason of 3 characters or more. */
export function formHeld(form: RequestForm): string | null {
  const text = form.name === 'identity' ? form.how : form.reason
  if (form.name === 'withdraw') return text.trim().length > 1000 ? 'dp.form.tooLong' : null
  if (text.trim().length < 3) return form.name === 'identity' ? 'dp.form.how' : 'dp.form.reason'
  return text.trim().length > (form.name === 'refuse' ? 2000 : 1000) ? 'dp.form.tooLong' : null
}

export type { RequestView }
