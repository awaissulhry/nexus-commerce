import {
  CHANGE_EFFECTS,
  CHANGE_LIMITS,
  CHANGE_ORDER_STATUSES,
  CHANGE_PRIORITIES,
  CHANGE_REFUSALS,
  CHANGE_REQUEST_SOURCES,
  CHANGE_REQUEST_STATUSES,
  OFFICE_SOURCES,
  WIP_DISPOSITIONS,
  isLiveOrder,
  type ChangeDecision,
  type ChangeEffect,
  type ChangeOrderStatus,
  type ChangePriority,
  type ChangeRequestSource,
  type ChangeRequestStatus,
  type OfficeSource,
  type WipDisposition,
} from '@nexus/factory-domain/product/changes/rules'
import { CHANGE_KINDS, CHANGE_ROWS, CHANGE_TILES, changeListsOf, changeRowId, type ChangeKind, type ChangeLists, type ChangeRows, type ChangeTile } from '@nexus/factory-domain/product/changes/screens'
import type { CreateOrderBody, CreateRequestBody, UpdateOrderBody, UpdateRequestBody } from '@nexus/factory-domain/product/changes/contracts'
import { EDIT_REFUSALS } from '@nexus/factory-domain/product/lifecycle/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { OrderList, OrderRow, OrderView, RequestList, RequestRow, RequestView, SmvWaiting, StyleDetail } from './api'

/**
 * Products › Development › Changes & versions (SCR-117, B-W2b-244), pure: who may do what, the page's address (one filter
 * model: the tiles are saved rows), the one list over three reads (change requests, change orders, the SMV changes waiting
 * from Operations), each row's words and why a verb is held, the notices, New change request and New change order (draft,
 * held, body), the record's drafts and what a save sends, the approvers and the work in progress, refusals said from their
 * codes. Every word is a key of `products-changes`.
 */

export const NS = 'products-changes'
export const NAMESPACES = [NS, 'lists'] as const

export { CHANGE_EFFECTS, CHANGE_KINDS, CHANGE_ORDER_STATUSES, CHANGE_PRIORITIES, CHANGE_REQUEST_SOURCES, CHANGE_REQUEST_STATUSES, CHANGE_ROWS, CHANGE_TILES, OFFICE_SOURCES, WIP_DISPOSITIONS }
export type { ChangeDecision, ChangeEffect, ChangeKind, ChangeOrderStatus, ChangePriority, ChangeRequestSource, ChangeRequestStatus, ChangeRows, ChangeTile, OfficeSource, WipDisposition }

/** A phrase of the catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ---- who may do what --------------------------------------------------------------------------------------------------------

export interface ChangesCan {
  view: boolean
  /** New change request, its what / why / priority (product.changes.request). */
  request: boolean
  /** Triage, change orders: write, submit, release, cancel (product.changes.manage). */
  manage: boolean
  /** Approve or reject a change order named to them (product.changes.approve). */
  approve: boolean
  /** The SMV changes waiting from Operations (product.routing.view) and their decision (product.smv.approve). */
  smvView: boolean
  smvDecide: boolean
  /** The redline and the open quotes and orders on older revisions (product.bom.view, B-W2b-220's reads). */
  bom: boolean
  /** The style picker (product.styles.view), the customer and supplier pickers (parties.view), the rounds (sales.samples.view). */
  styles: boolean
  parties: boolean
  samples: boolean
  /** A work order's own page (workorders.view). */
  workOrders: boolean
  /** Photos onto a request (files.upload). */
  files: boolean
  /** The record's thread, files and history (threads.read). */
  thread: boolean
}

export function changesCan(permissions: readonly string[]): ChangesCan {
  const held = new Set(permissions)
  const has = (permission: string) => held.has(permission)
  return {
    view: has('product.changes.view'),
    request: has('product.changes.request'),
    manage: has('product.changes.manage'),
    approve: has('product.changes.approve'),
    smvView: has('product.routing.view'),
    smvDecide: has('product.smv.approve'),
    bom: has('product.bom.view'),
    styles: has('product.styles.view'),
    parties: has('parties.view'),
    samples: has('sales.samples.view'),
    workOrders: has('workorders.view'),
    files: has('files.upload'),
    thread: has('threads.read'),
  }
}

// ---- the page's address -----------------------------------------------------------------------------------------------------

export type ChangesView = 'changes' | 'released'

export interface ListAddress {
  /** Changes (the default) or the versions released (`?view=released`). */
  readonly view: ChangesView
  /** A saved row (a tile is one): null = every change. The term is `?tile=` (B-W2b-226's tiles are its names). */
  readonly tile: ChangeRows | null
  readonly kind: ChangeKind | null
  /** One style's changes (the Style studio's link). */
  readonly style: string | null
  readonly q: string
  /** New change request (`?new=1`, with `&style=` from the Style studio). */
  readonly isNew: boolean
  /** New change order (`?newOrder=1`, with `&style=` and the request it carries `&request=`). */
  readonly newOrder: boolean
  readonly request: string | null
  /** Approve change for one row (`?decide=order:<id>`), as Home › Approvals will open it. */
  readonly decide: string | null
}

export const HOME_ADDRESS: ListAddress = { view: 'changes', tile: null, kind: null, style: null, q: '', isNew: false, newOrder: false, request: null, decide: null }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | null => (value && UUID.test(value) ? value : null)
const ROW_ID = /^(request|order|smv):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function addressOf(params: { get(name: string): string | null }): ListAddress {
  const tile = oneOf(CHANGE_ROWS, params.get('tile'))
  const decide = params.get('decide')
  return {
    view: params.get('view') === 'released' ? 'released' : 'changes',
    tile: tile === 'ALL' ? null : tile,
    kind: oneOf(CHANGE_KINDS, params.get('kind')),
    style: idOf(params.get('style')) ?? idOf(params.get('styleId')),
    q: (params.get('q') ?? '').slice(0, 100),
    isNew: params.get('new') === '1',
    newOrder: params.get('newOrder') === '1',
    request: idOf(params.get('request')),
    decide: decide && ROW_ID.test(decide) ? decide : null,
  }
}

export function addressText(address: ListAddress): string {
  const params = new URLSearchParams()
  if (address.view === 'released') params.set('view', 'released')
  if (address.tile && address.view === 'changes') params.set('tile', address.tile)
  if (address.kind && address.view === 'changes') params.set('kind', address.kind)
  if (address.style) params.set('style', address.style)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.isNew) params.set('new', '1')
  if (address.newOrder) params.set('newOrder', '1')
  if (address.newOrder && address.request) params.set('request', address.request)
  if (address.decide) params.set('decide', address.decide)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Anything narrowing the list beyond "every change". */
export const isFiltered = (address: ListAddress): boolean => (address.view === 'changes' && (address.tile !== null || address.kind !== null)) || !!address.style || !!address.q.trim()

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}/products/changes${addressText({ ...HOME_ADDRESS, ...address })}`

/** The lists this address reads (the saved row, the kind). */
export const listsOf = (address: ListAddress): ChangeLists => changeListsOf(address.tile ?? 'ALL', address.kind)

// ---- the record's address ----------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['change', 'impact', 'approvals', 'affected', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export type RecordKind = 'request' | 'order'

export function recordTabOf(params: { get(name: string): string | null }): RecordTab {
  return oneOf(RECORD_TABS, params.get('tab')) ?? 'change'
}

export function recordHref(prefix: string, kind: RecordKind, id: string, tab?: RecordTab): string {
  return `${prefix}/products/changes/${kind === 'request' ? 'requests' : 'orders'}/${encodeURIComponent(id)}${tab && tab !== 'change' ? `?tab=${tab}` : ''}`
}

/** An SMV change opens on its operation's record (B-W2b-235's Minutes there). */
export const operationHref = (prefix: string, operationId: string): string => `${prefix}/products/operations/${encodeURIComponent(operationId)}`
export const styleHref = (prefix: string, styleId: string, revisionId?: string | null): string =>
  `${prefix}/products/styles/${encodeURIComponent(styleId)}${revisionId ? `?rev=${encodeURIComponent(revisionId)}` : ''}`
export const workOrderHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}`

// ---- the one list ------------------------------------------------------------------------------------------------------------

interface RowBase {
  /** `<kind>:<record id>` (the list frame's row id; an export's selected ids). */
  readonly id: string
  readonly recordId: string
  readonly companyId: string | null
  /** Its number; null on a floor request nobody took up yet. */
  readonly number: string | null
  readonly title: string
  readonly reason: string
  /** When it was raised, written or proposed (the list is newest first). */
  readonly at: string
}

export type ChangeRow =
  | (RowBase & { readonly kind: 'request'; readonly request: RequestRow })
  | (RowBase & { readonly kind: 'order'; readonly order: OrderRow })
  | (RowBase & { readonly kind: 'smv'; readonly smv: SmvWaiting })

export const rowOfRequest = (request: RequestRow): ChangeRow => ({ kind: 'request', id: changeRowId('request', request.id), recordId: request.id, companyId: request.companyId, number: request.number, title: request.title, reason: request.reason, at: request.createdAt, request })
export const rowOfOrder = (order: OrderRow): ChangeRow => ({ kind: 'order', id: changeRowId('order', order.id), recordId: order.id, companyId: order.companyId, number: order.number, title: order.title, reason: order.reason, at: order.createdAt, order })
export const rowOfSmv = (smv: SmvWaiting): ChangeRow => ({
  kind: 'smv',
  id: changeRowId('smv', smv.proposal.id),
  recordId: smv.proposal.id,
  companyId: smv.operation.companyId,
  number: `${smv.operation.code} v${smv.proposal.number}`,
  title: smv.operation.name,
  reason: smv.proposal.reason,
  at: smv.proposal.proposedAt,
  smv,
})

/** What the page read: each list (null: not read under these rows, or not in the role), and the SMV read's state. */
export interface ChangesRead {
  readonly requests: RequestList | null
  readonly orders: OrderList | null
  readonly smv: { readonly rows: readonly SmvWaiting[]; readonly count: number } | null
  /** The SMV read failed (the rest stays). */
  readonly smvFailed: boolean
}

/** The rows the address shows, in its order: newest first (to triage: most urgent first, the API's order). */
export function rowsOf(read: ChangesRead, address: ListAddress): ChangeRow[] {
  const lists = listsOf(address)
  const q = address.q.trim().toLowerCase()
  const smv = lists.smv && !address.style ? (read.smv?.rows ?? []).filter((one) => (lists.smv === 'all' || one.mayDecide) && (!q || `${one.operation.code} ${one.operation.name}`.toLowerCase().includes(q))) : []
  const rows = [...(lists.requests ? (read.requests?.rows ?? []).map(rowOfRequest) : []), ...(lists.orders ? (read.orders?.rows ?? []).map(rowOfOrder) : []), ...smv.map(rowOfSmv)]
  if (address.tile === 'TO_TRIAGE') return rows
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

/** Each tile's number: the list's total under that saved row (null: not known — '—', never 0). */
export function tileCounts(read: ChangesRead | null): Record<ChangeTile, number | null> {
  const requests = read?.requests?.counts ?? null
  const orders = read?.orders?.counts ?? null
  const mineSmv = read?.smv ? read.smv.rows.filter((one) => one.mayDecide).length : 0
  return {
    TO_TRIAGE: requests ? (requests.TO_TRIAGE ?? 0) : null,
    MINE_TO_APPROVE: orders ? (orders.MINE_TO_APPROVE ?? 0) + mineSmv : null,
    TO_RELEASE: orders ? (orders.TO_RELEASE ?? 0) : null,
    RELEASED_THIS_MONTH: orders ? (orders.RELEASED_THIS_MONTH ?? 0) : null,
  }
}

/** Every list read whole (each read stops at its limit). */
export const isComplete = (read: ChangesRead): boolean => (read.requests?.complete ?? true) && (read.orders?.complete ?? true)

// ---- a row in words ----------------------------------------------------------------------------------------------------------

export const REQUEST_TONE: Readonly<Record<ChangeRequestStatus, Tone>> = { OPEN: 'warning', IN_REVIEW: 'info', ACCEPTED: 'success', REJECTED: 'danger', DONE: 'neutral' }
export const ORDER_TONE: Readonly<Record<ChangeOrderStatus, Tone>> = { DRAFT: 'neutral', SUBMITTED: 'warning', APPROVED: 'info', REJECTED: 'danger', RELEASED: 'success', CANCELLED: 'neutral' }
export const PRIORITY_TONE: Readonly<Record<ChangePriority, Tone>> = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' }

/** The status of any row: its key and tone. */
export function statusOf(row: ChangeRow): { key: string; tone: Tone } {
  if (row.kind === 'request') return { key: `request.${row.request.status}`, tone: REQUEST_TONE[row.request.status] }
  if (row.kind === 'order') return { key: `order.${row.order.status}`, tone: ORDER_TONE[row.order.status] }
  return { key: 'smv.PROPOSED', tone: 'warning' }
}

/** "You" / "A colleague" (a person's name only inside one record). */
export const personPhrase = (personId: string | null, me: string): Phrase => ({ key: personId === null ? 'person.none' : personId === me ? 'person.me' : 'person.other' })

/** Who raised it: a request's source (and its customer or supplier); an order's author; an SMV change's proposer. */
export function raisedByPhrase(row: ChangeRow, me: string): Phrase {
  if (row.kind === 'request') {
    const request = row.request
    if (request.party) return { key: 'raised.party', params: { source: `source.${request.source}`, party: request.party.name } }
    if (request.sampleRound) return { key: 'raised.round', params: { round: request.sampleRound.number } }
    if (request.source === 'OFFICE') return { key: 'raised.office', params: { person: personPhrase(request.createdById, me).key } }
    return { key: `source.${request.source}` }
  }
  if (row.kind === 'order') return personPhrase(row.order.authorId, me)
  return personPhrase(row.smv.proposal.proposedBy.id, me)
}

/** When it takes effect: an order's day (or Next order / At once); an SMV change's first day; a request: none. */
export function effectivePhrase(row: ChangeRow): Phrase | null {
  if (row.kind === 'order') return row.order.effect === 'DATE' && row.order.effectiveDate ? { key: 'effect.on', params: { day: row.order.effectiveDate } } : { key: `effect.${row.order.effect}` }
  if (row.kind === 'smv') return { key: 'effect.on', params: { day: row.smv.proposal.effectiveFrom } }
  return null
}

/** "2 of 3" (required approvals given, of those required); an SMV change needs one approval; a request: none. */
export function approvalsPhrase(row: ChangeRow): Phrase | null {
  if (row.kind === 'order') return row.order.approvals.required > 0 ? { key: 'approvals.count', params: { approved: row.order.approvals.approved, required: row.order.approvals.required } } : { key: 'approvals.none' }
  if (row.kind === 'smv') return { key: 'approvals.count', params: { approved: 0, required: 1 } }
  return null
}

/** The row's number in words: a floor request nobody took up yet has none. */
export const numberPhrase = (row: ChangeRow): Phrase => (row.number ? { key: 'row.number', params: { number: row.number } } : { key: 'row.floorNoNumber' })

/** The styles it touches (one style per change in V1; an SMV change touches an operation of the library). */
export function stylesOf(row: ChangeRow): { code: string; name: string } {
  if (row.kind === 'request') return { code: row.request.style.code, name: row.request.style.name }
  if (row.kind === 'order') return { code: row.order.style.code, name: row.order.style.name }
  return { code: row.smv.operation.code, name: row.smv.operation.name }
}

/** "52.000 → 58.400 min" for an SMV change (minutes are not money; decimals as the API writes them). */
export const smvMove = (smv: SmvWaiting): { from: string; to: string } => ({ from: smv.operation.standardMinutes, to: smv.proposal.standardMinutes })

// ---- the verbs: Open, Approve, Reject (⋯, right-click, the A / R keys of Approve change) --------------------------------------

/** Why Approve / Reject may not be pressed on a row (null: it may; the popup reads the record for the final word). */
export function decideHeldOfRow(row: ChangeRow, can: ChangesCan, me: string, offline: boolean): Phrase | null {
  if (row.kind === 'request') {
    if (!can.manage) return { key: 'held.noTriage' }
    if (row.request.status !== 'OPEN' && row.request.status !== 'IN_REVIEW') return { key: 'held.requestDecided', params: { status: `request.${row.request.status}` } }
  } else if (row.kind === 'order') {
    if (!can.approve) return { key: 'held.noApprove' }
    if (row.order.authorId === me) return { key: 'refusal.OWN_APPROVAL' }
    if (row.order.status !== 'SUBMITTED') return { key: 'held.orderNotWaiting', params: { status: `order.${row.order.status}` } }
  } else {
    if (!can.smvDecide) return { key: 'held.noSmvApprove' }
    if (row.smv.proposal.proposedBy.id === me) return { key: 'held.ownSmv' }
    if (!row.smv.mayDecide) return { key: 'held.noSmvApprove' }
  }
  return offline ? { key: 'held.offline' } : null
}

// ---- the notices (one Banner at a time, the most serious first) -------------------------------------------------------------

export interface PageNotice extends Phrase {
  readonly id: string
  readonly tone: 'info' | 'warning' | 'danger'
}

const SEVERITY: Readonly<Record<PageNotice['tone'], number>> = { danger: 0, warning: 1, info: 2 }

/** What the list cannot show or apply, most serious first (design changes.notices: server-ignored filters, data it lacks). */
export function noticesOf(read: ChangesRead | null, address: ListAddress, can: ChangesCan): PageNotice[] {
  if (!read || address.view !== 'changes') return []
  const lists = listsOf(address)
  const notices: PageNotice[] = []
  if (lists.smv && read.smvFailed) notices.push({ id: 'smvFailed', key: 'notice.smvFailed', tone: 'warning' })
  if (lists.smv && !can.smvView) notices.push({ id: 'smvRole', key: 'notice.smvRole', tone: 'info' })
  if (lists.smv && can.smvView && address.style) notices.push({ id: 'smvStyle', key: 'notice.smvStyle', tone: 'info' })
  if (!isComplete(read)) notices.push({ id: 'incomplete', key: 'notice.incomplete', tone: 'warning' })
  return notices.sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone])
}

// ---- refusals and problems --------------------------------------------------------------------------------------------------

/** Every refusal code the reads and writes here may send (`refusal/<CODE>`), each with its words in the catalogue. */
export const KNOWN_REFUSALS: readonly string[] = [...new Set<string>([...CHANGE_REFUSALS, ...EDIT_REFUSALS, 'REVISION_LOCKED'])]

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

/** A refusal said in our words: its code (else `refusal.other`). */
export const refusalPhrase = (code: string | null | undefined): Phrase => ({ key: code && KNOWN_REFUSALS.includes(code) ? `refusal.${code}` : 'refusal.other' })

/** A failed read in words (a failed read is never drawn as an empty list). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'forbidden':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'signed_out':
      return 'problem.signedOut'
    case 'contract':
      return 'problem.contract'
    case 'rate_limited':
      return 'problem.rateLimited'
    default:
      return 'problem.unavailable'
  }
}

export interface WriteProblem extends Phrase {
  /** The API's places of a 400 (`body/title` → `title`). */
  readonly paths: readonly string[]
  /** Someone changed it first: read it again. */
  readonly stale: boolean
}

/** A refused write in words: a rule's refusal by its code, a stale version, a refused field, the kind. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { ...refusalPhrase(code), paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.stale', paths: [], stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'step_up') return { key: 'problem.stepUp', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

const FIELDS = ['title', 'reason', 'description', 'priority', 'effect', 'effectiveDate', 'partyId', 'sampleRoundId', 'revisionId', 'styleId', 'companyId', 'requestIds', 'approvers', 'lines', 'note'] as const

/** A 400's place in our words (`approvers/0/userId` → the approvers). */
export function fieldOfPath(path: string): string {
  const head = path.split('/')[0] ?? ''
  return (FIELDS as readonly string[]).includes(head) ? `field.${head}` : 'field.other'
}

// ---- New change request ------------------------------------------------------------------------------------------------------

export interface NewRequestDraft {
  styleId: string | null
  source: OfficeSource
  partyId: string | null
  sampleRoundId: string | null
  /** The revision it is about ('' : the style as it is). */
  revisionId: string
  priority: ChangePriority
  title: string
  reason: string
  /** Photos picked, sent once the request is raised. */
  photos: readonly File[]
}

export const emptyNewRequest = (styleId: string | null = null): NewRequestDraft => ({ styleId, source: 'OFFICE', partyId: null, sampleRoundId: null, revisionId: '', priority: 'NORMAL', title: '', reason: '', photos: [] })

/** Why Raise request is held (null: it may be raised). */
export function newRequestHeld(draft: NewRequestDraft, style: Pick<StyleDetail, 'id'> | null, can: ChangesCan, offline: boolean): Phrase | null {
  if (!can.request) return { key: 'held.noRequest' }
  if (offline) return { key: 'held.offline' }
  if (!draft.styleId || !style) return { key: 'new.heldStyle' }
  if ((draft.source === 'CUSTOMER' || draft.source === 'SUPPLIER') && !draft.partyId) return { key: draft.source === 'CUSTOMER' ? 'new.heldCustomer' : 'new.heldSupplier' }
  if (draft.source === 'SAMPLE' && !draft.sampleRoundId) return { key: 'new.heldRound' }
  if (!draft.title.trim()) return { key: 'new.heldTitle' }
  if (draft.title.trim().length > CHANGE_LIMITS.title) return { key: 'new.heldTitleLong', params: { max: CHANGE_LIMITS.title } }
  if (!draft.reason.trim()) return { key: 'new.heldReason' }
  return null
}

/** Why a source may not be picked (its picker needs a right). */
export function sourceHeld(source: OfficeSource, can: ChangesCan): Phrase | null {
  if ((source === 'CUSTOMER' || source === 'SUPPLIER') && !can.parties) return { key: 'held.needs', params: { right: 'right.parties.view' } }
  if (source === 'SAMPLE' && !can.samples) return { key: 'held.needs', params: { right: 'right.sales.samples.view' } }
  return null
}

export function newRequestBody(draft: NewRequestDraft, style: Pick<StyleDetail, 'id' | 'companyId'>, companyId: string | null): CreateRequestBody {
  return {
    styleId: style.id,
    ...(style.companyId === null && companyId ? { companyId } : {}),
    source: draft.source,
    ...((draft.source === 'CUSTOMER' || draft.source === 'SUPPLIER') && draft.partyId ? { partyId: draft.partyId } : {}),
    ...(draft.source === 'SAMPLE' && draft.sampleRoundId ? { sampleRoundId: draft.sampleRoundId } : {}),
    ...(draft.revisionId ? { revisionId: draft.revisionId } : {}),
    title: draft.title.trim(),
    reason: draft.reason.trim(),
    priority: draft.priority,
  }
}

// ---- New change order -----------------------------------------------------------------------------------------------------------

export interface NewOrderDraft {
  styleId: string | null
  title: string
  reason: string
  priority: ChangePriority
  effect: ChangeEffect
  /** YYYY-MM-DD, only with DATE. */
  effectiveDate: string
  /** The requests it carries (of the style). */
  requestIds: readonly string[]
}

export const emptyNewOrder = (styleId: string | null = null, requestIds: readonly string[] = []): NewOrderDraft => ({ styleId, title: '', reason: '', priority: 'NORMAL', effect: 'NEXT_ORDER', effectiveDate: '', requestIds })

/** A change order still going (DRAFT, SUBMITTED, APPROVED): it holds its proposed revision and its requests. */
export const isLiveOrderStatus = (status: ChangeOrderStatus): boolean => isLiveOrder(status)

/** A request of the style a new change order may carry: open, in review or accepted, and in no live change order. */
export const linkable = (request: RequestRow): boolean => (request.status === 'OPEN' || request.status === 'IN_REVIEW' || request.status === 'ACCEPTED') && (request.changeOrder === null || !isLiveOrderStatus(request.changeOrder.status))

export function newOrderHeld(draft: NewOrderDraft, style: Pick<StyleDetail, 'id' | 'revisions'> | null, can: ChangesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (offline) return { key: 'held.offline' }
  if (!draft.styleId || !style) return { key: 'new.heldStyle' }
  if (!style.revisions.some((revision) => revision.status === 'RELEASED')) return { key: 'refusal.NO_RELEASED_REVISION' }
  if (!draft.title.trim()) return { key: 'new.heldTitle' }
  if (!draft.reason.trim()) return { key: 'new.heldReason' }
  if (draft.effect === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveDate)) return { key: 'refusal.EFFECT_DATE' }
  return null
}

export function newOrderBody(draft: NewOrderDraft, style: Pick<StyleDetail, 'id' | 'companyId'>, companyId: string | null): CreateOrderBody {
  return {
    styleId: style.id,
    ...(style.companyId === null && companyId ? { companyId } : {}),
    title: draft.title.trim(),
    reason: draft.reason.trim(),
    priority: draft.priority,
    effect: draft.effect,
    ...(draft.effect === 'DATE' ? { effectiveDate: draft.effectiveDate } : {}),
    ...(draft.requestIds.length > 0 ? { requestIds: [...draft.requestIds] } : {}),
  }
}

// ---- the record: a request ------------------------------------------------------------------------------------------------------

export interface RequestDraft {
  title: string
  reason: string
  priority: ChangePriority
  revisionId: string
}

export const requestDraftOf = (request: RequestView): RequestDraft => ({ title: request.title, reason: request.reason, priority: request.priority, revisionId: request.revision?.id ?? '' })

/** Which of a request's fields may change now: all until decided, the priority alone once accepted, none after. */
export function requestEditable(request: Pick<RequestView, 'status'>, can: ChangesCan, offline: boolean): { fields: 'all' | 'priority' | 'none'; why: Phrase | null } {
  if (!can.request) return { fields: 'none', why: { key: 'held.viewOnly' } }
  if (request.status === 'REJECTED' || request.status === 'DONE') return { fields: 'none', why: { key: 'refusal.REQUEST_DECIDED' } }
  if (offline) return { fields: 'none', why: { key: 'held.offline' } }
  return request.status === 'ACCEPTED' ? { fields: 'priority', why: { key: 'request.priorityOnly' } } : { fields: 'all', why: null }
}

/** What a save of the request sends: only what changed, with the version; problems said first. */
export function requestChanges(request: RequestView, draft: RequestDraft): { body: UpdateRequestBody | null; count: number; problem: Phrase | null } {
  const body: { version: number; title?: string; reason?: string; priority?: ChangePriority; revisionId?: string | null } = { version: request.version }
  let count = 0
  if (draft.title.trim() !== request.title) {
    if (!draft.title.trim()) return { body: null, count: 1, problem: { key: 'new.heldTitle' } }
    body.title = draft.title.trim()
    count++
  }
  if (draft.reason.trim() !== request.reason) {
    if (!draft.reason.trim()) return { body: null, count: 1, problem: { key: 'new.heldReason' } }
    body.reason = draft.reason.trim()
    count++
  }
  if (draft.priority !== request.priority) {
    body.priority = draft.priority
    count++
  }
  if (draft.revisionId !== (request.revision?.id ?? '')) {
    body.revisionId = draft.revisionId || null
    count++
  }
  return { body: count > 0 ? body : null, count, problem: null }
}

/** A triage move held: its refusal from the API (`moves[]`), no right, offline. */
export function moveHeld(request: RequestView, to: 'IN_REVIEW' | 'ACCEPTED' | 'REJECTED', can: ChangesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noTriage' }
  const move = request.moves.find((one) => one.to === to)
  if (move && !move.allowed) return refusalPhrase(move.refusal?.code)
  return offline ? { key: 'held.offline' } : null
}

// ---- the record: a change order -----------------------------------------------------------------------------------------------

export interface OrderDraft {
  title: string
  reason: string
  description: string
  priority: ChangePriority
  effect: ChangeEffect
  effectiveDate: string
}

export const orderDraftOf = (order: OrderView): OrderDraft => ({
  title: order.title,
  reason: order.reason,
  description: order.description ?? '',
  priority: order.priority,
  effect: order.effect,
  effectiveDate: order.effectiveDate ?? '',
})

/** A record action held: no right (said as such: the API's own word for it is a state), its refusal from the API (`actions.*`), offline. */
export function actionHeld(order: OrderView, action: keyof OrderView['actions'], can: ChangesCan, offline: boolean): Phrase | null {
  if (action === 'decide' ? !can.approve : !can.manage) return { key: action === 'decide' ? 'held.noApprove' : 'held.noManage' }
  const state = order.actions[action]
  if (!state.allowed) return refusalPhrase(state.refusal?.code)
  return offline ? { key: 'held.offline' } : null
}

/** What a save of the change order sends: only what changed; the priority alone once it is not a draft. */
export function orderChanges(order: OrderView, draft: OrderDraft): { body: UpdateOrderBody | null; count: number; problem: Phrase | null } {
  const body: { version: number; title?: string; reason?: string; description?: string | null; priority?: ChangePriority; effect?: ChangeEffect; effectiveDate?: string | null } = { version: order.version }
  let count = 0
  if (order.status === 'DRAFT') {
    if (draft.title.trim() !== order.title) {
      if (!draft.title.trim()) return { body: null, count: 1, problem: { key: 'new.heldTitle' } }
      body.title = draft.title.trim()
      count++
    }
    if (draft.reason.trim() !== order.reason) {
      if (!draft.reason.trim()) return { body: null, count: 1, problem: { key: 'new.heldReason' } }
      body.reason = draft.reason.trim()
      count++
    }
    if (draft.description.trim() !== (order.description ?? '')) {
      body.description = draft.description.trim() || null
      count++
    }
    if (draft.effect !== order.effect || (draft.effect === 'DATE' && draft.effectiveDate !== (order.effectiveDate ?? ''))) {
      if (draft.effect === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveDate)) return { body: null, count: 1, problem: { key: 'refusal.EFFECT_DATE' } }
      body.effect = draft.effect
      body.effectiveDate = draft.effect === 'DATE' ? draft.effectiveDate : null
      count++
    }
  }
  if (draft.priority !== order.priority) {
    body.priority = draft.priority
    count++
  }
  return { body: count > 0 ? body : null, count, problem: null }
}

export interface ApproverLine {
  userId: string
  name: string
  required: boolean
  /** Decided approvals stay as they are (the API keeps them). */
  decided: boolean
}

export const approversOf = (order: OrderView): ApproverLine[] =>
  order.approvalsList.map((approval) => ({ userId: approval.approverId, name: approval.approverName ?? '', required: approval.required, decided: approval.decision !== null }))

/** Why the approvers may not be saved as drafted (null: they may). */
export function approversHeld(order: OrderView, lines: readonly ApproverLine[], can: ChangesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (order.status !== 'DRAFT' && order.status !== 'SUBMITTED') return { key: 'refusal.ORDER_NOT_DRAFT' }
  if (lines.some((line) => line.userId === order.authorId)) return { key: 'refusal.OWN_APPROVAL' }
  if (lines.length > CHANGE_LIMITS.approvers) return { key: 'approvers.tooMany', params: { max: CHANGE_LIMITS.approvers } }
  return offline ? { key: 'held.offline' } : null
}

export interface WipLine {
  workOrderId: string
  number: string
  disposition: WipDisposition | ''
}

/** Every open work order of the style: its line (a disposition) or none yet. */
export function wipLinesOf(order: OrderView): WipLine[] {
  const lines: WipLine[] = order.workInProgress.map((line) => ({ workOrderId: line.workOrder.id, number: line.workOrder.number, disposition: line.disposition }))
  for (const open of order.openWorkOrders ?? []) lines.push({ workOrderId: open.id, number: open.number, disposition: '' })
  return lines
}

/** The work-in-progress body: the lines with a disposition (the whole list, replaced at once). */
export const wipBody = (lines: readonly WipLine[]): { workOrderId: string; disposition: WipDisposition }[] =>
  lines.filter((line): line is WipLine & { disposition: WipDisposition } => line.disposition !== '').map((line) => ({ workOrderId: line.workOrderId, disposition: line.disposition }))

export const sameWip = (order: OrderView, lines: readonly WipLine[]): boolean => {
  const now = new Map(order.workInProgress.map((line) => [line.workOrder.id, line.disposition]))
  const next = wipBody(lines)
  return next.length === now.size && next.every((line) => now.get(line.workOrderId) === line.disposition)
}

// ---- Approve change ------------------------------------------------------------------------------------------------------------

/** What Approve change sends: approve (a request: accept), reject (with why), or a request into review. */
export type DecideChoice = ChangeDecision | 'IN_REVIEW'

/** Why one of Approve change's buttons is held (a rejection needs its why). */
export function decideHeld(choice: DecideChoice, reason: string, held: Phrase | null): Phrase | null {
  if (held) return held
  if (choice === 'REJECTED' && !reason.trim()) return { key: 'refusal.REASON_NEEDED' }
  return null
}

/** The compare section's name in the page's words (its id; the API's label is English). */
export const sectionKey = (id: string): string => `section.${id}`
