import {
  CLOSED_STATUSES,
  DECLINE_REASONS,
  INQUIRY_LIMITS,
  INQUIRY_REFUSALS,
  INQUIRY_SOURCES,
  INQUIRY_STATUSES,
  INQUIRY_TILES,
  isOpen,
  LAWFUL_BASES,
  quotableLines,
  SIZE_CODE,
  TYPED_SOURCES,
  WORKING_DAY_MINUTES,
  askInfoRefusal,
  assignRefusal,
  declineRefusal,
  quoteRefusal,
  type DeclineReason,
  type InquirySource,
  type InquiryStatus,
  type InquiryTile,
  type TypedSource,
} from '@nexus/factory-domain/sales/inquiries/rules'
import type { LineBody, UpdateInquiryBody } from '@nexus/factory-domain/sales/inquiries/contracts'
// B-TH-230: the one waiting rule (amber).
import { amberOf, WAITING_THRESHOLD_DAYS } from '@nexus/factory-domain/threads/waiting'
// B-TH-235: what a request became (Sales › Reports' request figure opens the list with it).
import { REQUEST_OUTCOMES, type RequestOutcome } from '@nexus/factory-domain/sales/inquiries/rules'
// B-TH-233: Incoming over every door (B-TH-039's one read: requests, catalogue orders, change requests).
import { INCOMING_KINDS, INCOMING_TILES, stateWords, type IncomingKind, type IncomingTile } from '@nexus/factory-domain/sales/incoming/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { recordAddress } from '../../../lib/records/record-links'
import type { IncomingList, IncomingQuery, IncomingRow, InquiryFile, InquiryLine, InquiryRow, InquiryView, WaitingRow } from './api'
// B-TH-234: answer a new customer, hand the customer a task.
import type { CustomerCheck, CustomerMade, RequestTaskKind } from './api'
import type { MakeCustomerBody } from '@nexus/factory-domain/sales/inquiries/contracts'

/**
 * Sales › Inquiries (SCR-105, B-W2b-322 on B-W2b-295's API), pure: who may do what, the page's address (the tiles = the API's
 * saved filters, the filters, the inquiry open in its DetailModal and its tab), the tiles and notices, waiting time in words,
 * the row verbs held with their reason (factory-domain's own refusals, so the words come before the click), the lines asked
 * as a draft and back, the Request tab's draft and what Apply sends, New inquiry (typed, or from a mail), the bulk reach,
 * Make quote's preview and the decline's checks; refusals said from their codes. Every word is a key of `sales-inquiries`.
 */

export const NS = 'sales-inquiries'
export const NAMESPACES = [NS, 'lists'] as const

export { DECLINE_REASONS, INQUIRY_REFUSALS, INQUIRY_SOURCES, INQUIRY_STATUSES, INQUIRY_TILES, LAWFUL_BASES, TYPED_SOURCES }
export type { DeclineReason, InquirySource, InquiryStatus, InquiryTile, TypedSource }

/** A phrase of the catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  /** A link the notice offers ("Open quote QT-…"). */
  readonly link?: { readonly href: string; readonly label: Phrase } | null
  /** Lines under it (what was left out of a quote, the places a refusal named). */
  readonly lines?: readonly Phrase[]
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A read: loading, ready, or why not. */
export type Loaded<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly problem: string }
  | { readonly status: 'notFound' }
  | { readonly status: 'forbidden' }

// ---- who may do what ----------------------------------------------------------------------------------------------------

export interface InquiriesCan {
  view: boolean
  /** New inquiry, the Request's Apply, assign, ask for more information, decline, lost (sales.inquiries.manage). */
  manage: boolean
  /** Make quote also needs W1's quotes.manage. */
  quotes: boolean
  /** The quote it became, as a link (quotes.view). */
  quotesView: boolean
  /** The target price and the quote's value: a price (money.price). */
  price: boolean
  /** The customer pickers and the customer's page (parties.view). */
  parties: boolean
  /** The style picker (product.styles.view). */
  styles: boolean
  /** The inquiry's thread, files and history (threads.read). */
  thread: boolean
  /** Files added at New inquiry (files.upload). */
  upload: boolean
  /** The files' download (files.read). */
  files: boolean
  /** The decline's message to the customer goes through the thread (email.send). */
  email: boolean
  /** "Make an inquiry" from a mail (email.triage). */
  triage: boolean
  // ---- B-TH-228: Make order (orders.manage) and the order as a link (orders.view); Make style draft (product.styles.manage: the
  // production manager too) and the drafts as links (product.styles.view).
  orders?: boolean
  ordersView?: boolean
  stylesManage?: boolean
  // ---- end B-TH-228
  // ---- B-TH-234: "Ask <customer> for…" a task in its portal (partners.tasks.manage); a new customer from the prospect (parties.manage).
  tasks?: boolean
  partiesManage?: boolean
  // ---- end B-TH-234
  // ---- B-TH-290: planning's suggestion for production's answer (planning.promise.view); typing the answer is the record's own
  // productionAction (planning.promise.manage over the request).
  promise?: boolean
  // ---- end B-TH-290
}

export function inquiriesCan(permissions: readonly string[]): InquiriesCan {
  const held = new Set(permissions)
  const has = (permission: string) => held.has(permission)
  return {
    view: has('sales.inquiries.view'),
    manage: has('sales.inquiries.manage'),
    quotes: has('quotes.manage'),
    quotesView: has('quotes.view'),
    price: has('money.price'),
    parties: has('parties.view'),
    styles: has('product.styles.view'),
    thread: has('threads.read'),
    upload: has('files.upload'),
    files: has('files.read'),
    email: has('email.send'),
    triage: has('email.triage'),
    // B-TH-228
    orders: has('orders.manage'),
    ordersView: has('orders.view'),
    stylesManage: has('product.styles.manage'),
    // B-TH-234
    tasks: has('partners.tasks.manage'),
    partiesManage: has('parties.manage'),
    // B-TH-290
    promise: has('planning.promise.view'),
  }
}

/** The rights a held verb may name, each with words (`right.<permission>`). */
export const KNOWN_RIGHTS = ['sales.inquiries.manage', 'quotes.manage', 'email.send', 'files.upload', 'email.triage', 'orders.manage', 'product.styles.manage', /* B-TH-234 */ 'partners.tasks.manage', 'parties.manage'] as const

// ---- the page's address ---------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['request', 'files', 'quote', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The tile of a page without one: the API's default (every open inquiry). */
export const DEFAULT_TILE: IncomingTile = 'OPEN'

// ---- B-TH-233: the saved rows are Incoming's own (B-TH-039's tiles) plus "Customer replies" (B-TH-047, a view of conversations) ----
/** "Customer replies": the conversations on the customer's other records that wait on us (GET /threads/waiting?side=CUSTOMER). */
export const CUSTOMER_REPLIES = 'CUSTOMER_REPLIES' as const
export type ListTile = IncomingTile | typeof CUSTOMER_REPLIES
export const LIST_TILES: readonly ListTile[] = [...INCOMING_TILES, CUSTOMER_REPLIES]
export { INCOMING_KINDS }
export type { IncomingKind, IncomingTile }
// ---- end B-TH-233

export interface ListAddress {
  /** A tile = a saved filter (the API's own `tile`); OPEN when the address names none. B-TH-233: or "Customer replies". */
  readonly tile: ListTile
  /** B-TH-216: one state (the State cell narrows the list to it). */
  readonly status: InquiryStatus | null
  readonly source: InquirySource | null
  /** B-TH-216: one company (the Company cell narrows the list, for a reader who sees more than one). */
  readonly company: string | null
  /** One customer's inquiries. */
  readonly party: string | null
  /** From prospects only (no customer yet). */
  readonly prospect: boolean
  readonly q: string
  /** The inquiry open in its DetailModal (`?open=<id>`) and its tab. */
  readonly open: string | null
  readonly tab: RecordTab
  /** New inquiry (`?new=1`). */
  readonly isNew: boolean
  /** "Make an inquiry" from a mail of Mail to sort (`?mail=<inbound mail id>`). */
  readonly mail: string | null
  // ---- B-TH-235: Sales › Reports' request figure opens the list with the days the requests came and what each became.
  /** The first and last day a request came (Rome days, both included; `?from=&to=`). */
  readonly from: string | null
  readonly to: string | null
  /** What a request became, as the figure counts it (`?outcome=`): Ordered, Declined (not "Not an order"), Not an order, Withdrawn (B-TH-095). */
  readonly outcome: RequestOutcome | null
  // ---- end B-TH-235
  // ---- B-TH-233: one kind of row (`?kind=`), and the catalogue order open in the reading pane (`?catalogue=<id>`; a request is `?open=`).
  readonly kind: IncomingKind | null
  readonly catalogue: string | null
  // ---- end B-TH-233
}

export const HOME_ADDRESS: ListAddress = { tile: DEFAULT_TILE, status: null, source: null, company: null, party: null, prospect: false, q: '', open: null, tab: 'request', isNew: false, mail: null, from: null, to: null, outcome: null, kind: null, catalogue: null }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const idOf = (value: string | null): string | null => (value && UUID.test(value) ? value : null)
// B-TH-235: a day of the address, else none.
const dayOf = (value: string | null): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null }): ListAddress {
  const prospect = params.get('prospect') === '1'
  // B-TH-233: a catalogue order is `?catalogue=<id>`; a link that names the kind (`?kind=CATALOGUE_ORDER&open=<id>`) opens it too.
  const kind = oneOf(INCOMING_KINDS, params.get('kind'))
  const openAsCatalogue = kind === 'CATALOGUE_ORDER' && !params.get('catalogue') && !!idOf(params.get('open'))
  return {
    tile: oneOf(LIST_TILES, params.get('tile')) ?? DEFAULT_TILE, // B-TH-233: Incoming's tiles and Customer replies
    status: oneOf(INQUIRY_STATUSES, params.get('status')),
    source: oneOf(INQUIRY_SOURCES, params.get('source')),
    company: idOf(params.get('company')),
    party: prospect ? null : idOf(params.get('party')),
    prospect,
    q: (params.get('q') ?? '').slice(0, 100),
    open: openAsCatalogue ? null : idOf(params.get('open')),
    tab: oneOf(RECORD_TABS, params.get('tab')) ?? 'request',
    isNew: params.get('new') === '1',
    mail: idOf(params.get('mail')),
    // B-TH-235
    from: dayOf(params.get('from')),
    to: dayOf(params.get('to')),
    outcome: oneOf(REQUEST_OUTCOMES, params.get('outcome')),
    // B-TH-233: one kind; a catalogue order open beside the list (never with a request open: the request wins).
    kind,
    catalogue: openAsCatalogue ? idOf(params.get('open')) : idOf(params.get('open')) ? null : idOf(params.get('catalogue')),
  }
}

export function addressText(address: ListAddress): string {
  const params = new URLSearchParams()
  if (address.tile !== DEFAULT_TILE) params.set('tile', address.tile)
  if (address.status) params.set('status', address.status)
  if (address.source) params.set('source', address.source)
  if (address.company) params.set('company', address.company)
  if (address.prospect) params.set('prospect', '1')
  else if (address.party) params.set('party', address.party)
  if (address.q.trim()) params.set('q', address.q.trim())
  // B-TH-235
  if (address.from) params.set('from', address.from)
  if (address.to) params.set('to', address.to)
  if (address.outcome) params.set('outcome', address.outcome)
  // B-TH-233
  if (address.kind) params.set('kind', address.kind)
  if (address.open) params.set('open', address.open)
  else if (address.catalogue) params.set('catalogue', address.catalogue)
  if (address.open && address.tab !== 'request') params.set('tab', address.tab)
  if (address.isNew) params.set('new', '1')
  if (address.mail) params.set('mail', address.mail)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Anything narrowing the rows beyond the default tile. */
export const isFiltered = (address: ListAddress): boolean => address.tile !== DEFAULT_TILE || !!address.status || !!address.source || !!address.company || !!address.party || address.prospect || !!address.q.trim() || !!address.from || !!address.to || !!address.outcome /* B-TH-235 */ || !!address.kind /* B-TH-233 */

/** B-TH-216: Sales › Incoming (renamed from Inquiries; the old address redirects, shell/nav/renamed.ts). */
export const PAGE_PATH = '/sales/incoming'

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}${PAGE_PATH}${addressText({ ...HOME_ADDRESS, ...address })}`

/** The request's full page (a new tab; where a search result, a notification or a link opens it). */
export function recordHref(prefix: string, inquiryId: string, tab?: RecordTab): string {
  return `${prefix}${PAGE_PATH}/${encodeURIComponent(inquiryId)}${tab && tab !== 'request' ? `?tab=${tab}` : ''}`
}

export const recordTabOf = (params: { get(name: string): string | null }): RecordTab => oneOf(RECORD_TABS, params.get('tab')) ?? 'request'

// ── B-TH-219 (O-SAL-INQ-REC.band-F01): the full page remembers the list it came from (its filters and its order) ──

/** The full page of a request opened from the list: `?back=` keeps the list's filters (never an address of its own: only a query). */
export function fullPageHref(prefix: string, inquiryId: string, list: ListAddress): string {
  const query = addressText({ ...list, open: null, isNew: false, mail: null, catalogue: null })
  return `${recordHref(prefix, inquiryId)}?back=${encodeURIComponent(query || '?')}`
}

/** The list a full page came from: its address (the default list without `?back=`); anything but a query is ignored. */
export function backAddressOf(params: { get(name: string): string | null }): { readonly address: ListAddress; readonly back: string | null } {
  const back = params.get('back')
  if (!back || !back.startsWith('?')) return { address: HOME_ADDRESS, back: null }
  return { address: addressOf(new URLSearchParams(back.slice(1))), back }
}

/** "Back to Incoming": the list with its filters and this request open beside it. */
export const backHref = (prefix: string, list: ListAddress, inquiryId: string): string => listHref(prefix, { ...list, open: inquiryId, catalogue: null, isNew: false, mail: null })

/**
 * The query Incoming's one read takes for an address (B-TH-233: GET /sales/incoming). "Customer replies" lists conversations (its
 * own read); Incoming's read then brings the tiles' counts under the same filters (as for Open).
 */
export function queryOf(address: ListAddress): IncomingQuery {
  return {
    tile: address.tile === CUSTOMER_REPLIES ? DEFAULT_TILE : address.tile,
    kind: address.kind,
    status: address.status,
    source: address.source,
    companyId: address.company,
    partyId: address.prospect ? null : address.party,
    prospect: address.prospect,
    q: address.q.trim(),
    // B-TH-235
    receivedFrom: address.from,
    receivedTo: address.to,
    outcome: address.outcome,
  }
}

// ---- tiles, chips and notices ---------------------------------------------------------------------------------------------

/** The tiles (saved filters), in the tree's order (B-TH-216, O-SAL-INQ-LIST.tiles): New · Waiting on us over 1 working day · Need info · Quoted this week · Mine. */
export const DESIGN_TILES = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'MINE'] as const satisfies readonly IncomingTile[]
/**
 * Rows ▾ (the saved rows, list-F05), in the design's order: Open (the default) · Mine · the queue's own · Quoted · Ordered · Declined ·
 * Not an order · Lost · All, then "Customer replies" (B-TH-233: the one office inbox of conversations waiting on us, B-TH-047).
 * Catalogue orders and change requests are the Kind filter (`?kind=`), with every saved row.
 */
export const SAVED_ROWS = ['OPEN', 'MINE', 'NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'QUOTED', 'ORDERED', 'DECLINED', 'NOT_AN_ORDER', 'LOST', 'ALL', CUSTOMER_REPLIES] as const satisfies readonly ListTile[]

/** What a tile's number is read from: Incoming's counts (B-TH-233: `counts.CUSTOMER_REPLIES` too). */
type Counted = Pick<IncomingList, 'counts' | 'complete'>

/** A tile's number: the API's count under the filters; unknown is "—", never 0 (the design's rule). */
export function tileValue(list: Counted | null, tile: ListTile, failed: boolean): string {
  if (failed || !list) return '—'
  const value = list.counts[tile]
  return value === null || value === undefined ? '—' : String(value)
}

/** WAITING_US is counted on at most 1000 open inquiries: past that the API says the count is partial. */
export const tilePartial = (list: Counted | null, tile: ListTile): boolean => tile === 'WAITING_US' && !!list && !list.complete

export interface FilterChipModel {
  readonly id: 'tile' | 'status' | 'source' | 'company' | 'party' | 'prospect' | 'q' | 'received' | 'outcome' /* B-TH-235 */ | 'kind' /* B-TH-233 */
  readonly label: Phrase
  readonly clear: Partial<ListAddress>
}

/** The filter row: each filter a chip with ✕ (a tile's chip too: one filter model). */
export function chipsOf(address: ListAddress, partyName: string | null, companyName: string | null = null): FilterChipModel[] {
  const chips: FilterChipModel[] = []
  if (address.tile !== DEFAULT_TILE) chips.push({ id: 'tile', label: { key: 'chip.tile', params: { tile: `tile.${address.tile}` } }, clear: { tile: DEFAULT_TILE } })
  // B-TH-233: one kind of row (Requests, Catalogue orders, Change requests).
  if (address.kind) chips.push({ id: 'kind', label: { key: 'chip.kind', params: { kind: `kind.${address.kind}` } }, clear: { kind: null } })
  // B-TH-216: the State and Company cells narrow the list; each narrowing is a chip.
  if (address.status) chips.push({ id: 'status', label: { key: 'chip.status', params: { status: `status.${address.status}` } }, clear: { status: null } })
  if (address.source) chips.push({ id: 'source', label: { key: 'chip.source', params: { source: `source.${address.source}` } }, clear: { source: null } })
  if (address.company) chips.push({ id: 'company', label: companyName ? { key: 'chip.company', params: { name: companyName } } : { key: 'chip.companyUnknown' }, clear: { company: null } })
  if (address.prospect) chips.push({ id: 'prospect', label: { key: 'chip.prospect' }, clear: { prospect: false } })
  else if (address.party) chips.push({ id: 'party', label: partyName ? { key: 'chip.party', params: { name: partyName } } : { key: 'chip.partyUnknown' }, clear: { party: null } })
  if (address.q.trim()) chips.push({ id: 'q', label: { key: 'chip.q', params: { q: address.q.trim() } }, clear: { q: '' } })
  // B-TH-235: the days the requests came and what each became (Sales › Reports' request figure opens the list with them).
  if (address.from || address.to) chips.push({ id: 'received', label: address.from && address.to ? (address.from === address.to ? { key: 'chip.receivedOn', params: { day: address.from } } : { key: 'chip.received', params: { from: address.from, to: address.to } }) : address.from ? { key: 'chip.receivedFrom', params: { from: address.from } } : { key: 'chip.receivedTo', params: { to: address.to! } }, clear: { from: null, to: null } })
  if (address.outcome) chips.push({ id: 'outcome', label: { key: `chip.outcome.${address.outcome}` }, clear: { outcome: null } })
  return chips
}

export interface PageNotice extends Phrase {
  readonly tone: 'warning' | 'info'
  /** What a dismissal is kept by: a new value shows again. */
  readonly value: string
}

/**
 * The notices (design inquiries.notices): one Banner at a time, the most serious first; the rest behind "N more notices".
 * Data the list lacks (the waiting count partial past 1000 open inquiries, the first 200 rows only), and inquiries from
 * prospects that need a customer before a quote. Kept dismissed by value, so a new fact shows again.
 */
export interface NoticeFacts {
  /** B-TH-216 (L2-G03, B-TH-012): the companies (by name) with no active request numbering — read only for numbering.view holders. */
  readonly numberingMissing?: readonly string[] | null
  /** B-TH-216: the mails waiting in Mail to sort (a page of 50 at most) — read only for people who sort mail. */
  readonly mailToSort?: { readonly count: number; readonly more: boolean } | null
}

/**
 * B-TH-233: the list reads in pages now (Show more, the cursor), so the "first 200 rows" notice went; the prospects are counted on
 * the rows read (open requests of prospects, any kind's `open`).
 */
export function pageNotices(list: Pick<IncomingList, 'rows' | 'complete'> | null, dismissed: ReadonlySet<string>, facts: NoticeFacts = {}): PageNotice[] {
  if (!list) return []
  const notices: PageNotice[] = []
  // B-TH-216: the most serious first — a company whose portal and mail doors are off (no request numbering).
  for (const name of facts.numberingMissing ?? []) notices.push({ key: 'notice.numbering', params: { name }, tone: 'warning', value: `numbering:${name}` })
  if (!list.complete) notices.push({ key: 'notice.partial', tone: 'warning', value: 'partial' })
  const prospects = list.rows.filter((row) => row.prospect && row.open).length
  if (prospects > 0) notices.push({ key: 'notice.prospects', params: { count: prospects }, tone: 'info', value: `prospects:${prospects}` })
  // B-TH-216: mails that wait in Mail to sort (only for people who sort mail).
  const mail = facts.mailToSort
  if (mail && mail.count > 0) notices.push({ key: mail.more ? 'notice.mailMore' : 'notice.mail', params: { count: mail.count }, tone: 'info', value: `mail:${mail.count}${mail.more ? '+' : ''}` })
  return notices.filter((notice) => !dismissed.has(`${notice.key}:${notice.value}`))
}

export const noticeKey = (notice: Pick<PageNotice, 'key' | 'value'>): string => `${notice.key}:${notice.value}`

/** B-TH-216: where a notice's "Open" goes (Mail to sort; the numbering page), or null. */
export function noticeLink(notice: Pick<PageNotice, 'key'>, prefix: string): { readonly href: string; readonly label: Phrase } | null {
  if (notice.key === 'notice.mail' || notice.key === 'notice.mailMore') return { href: `${prefix}/home/mail-to-sort`, label: { key: 'notice.open' } }
  if (notice.key === 'notice.numbering') return { href: `${prefix}/admin/documents`, label: { key: 'notice.numberingOpen' } }
  return null
}

/** B-TH-216 (band-F01): the band's count, said in words for the current Rows ▾ choice ("41 open"); unknown is "—", never 0. */
export function bandCount(list: Counted | null, tile: ListTile, failed: boolean): Phrase {
  const value = failed || !list ? null : list.counts[tile]
  return value === null || value === undefined ? { key: 'band.countUnknown' } : { key: `band.count.${tile}`, params: { count: value } }
}

/** Where the dismissed notices are kept on this device (by value). */
export const DISMISSED_STORE = 'factory:sales.inquiries:dismissed'

// ---- status, source, waiting --------------------------------------------------------------------------------------------------

export const STATUS_TONE: Readonly<Record<InquiryStatus, Tone>> = {
  NEW: 'info',
  ASSIGNED: 'info',
  NEED_INFO: 'warning',
  QUOTED: 'success',
  DECLINED: 'neutral',
  LOST: 'neutral',
  // B-TH-022: made straight into an order.
  ORDERED: 'success',
  // B-TH-090: withdrawn by the customer before the office decided.
  WITHDRAWN: 'neutral',
}

export const isClosed = (status: InquiryStatus): boolean => (CLOSED_STATUSES as readonly string[]).includes(status)
export { isOpen }

/** Working minutes in words: minutes, working hours, or working days of 8 hours and hours. */
export function workingTime(minutes: number): Phrase {
  const whole = Math.max(0, Math.round(minutes))
  if (whole < 60) return { key: 'time.minutes', params: { n: whole } }
  if (whole < WORKING_DAY_MINUTES) return { key: 'time.hours', params: { n: Math.floor(whole / 60) } }
  const days = Math.floor(whole / WORKING_DAY_MINUTES)
  const hours = Math.floor((whole - days * WORKING_DAY_MINUTES) / 60)
  return hours > 0 ? { key: 'time.daysHours', params: { d: days, h: hours } } : { key: 'time.days', params: { d: days } }
}

/** The Waiting cell: for us (overdue in the danger tone) or for the customer; nothing once closed. */
export function waitingOf(row: Pick<InquiryRow, 'waiting'>): { readonly phrase: Phrase; readonly tone: Tone; readonly time: Phrase | null } | null {
  const { waiting } = row
  if (waiting.for === null) return null
  const time = waiting.workingMinutes === null ? null : workingTime(waiting.workingMinutes)
  // B-TH-230: amber by the ONE waiting rule (factory-domain threads/waiting: a request waiting on us past 1 working day) — the same
  // as the thread head's pill and Today; waiting on the customer is never amber (it is not ours to answer).
  if (waiting.for === 'CUSTOMER') return { phrase: { key: 'waiting.customer' }, tone: 'neutral', time }
  const amber = waiting.workingMinutes !== null && amberOf({ on: 'US', since: new Date(0), thresholdDays: WAITING_THRESHOLD_DAYS.REQUEST }, waiting.workingMinutes)
  return { phrase: { key: amber ? 'waiting.usOverdue' : 'waiting.us' }, tone: amber ? 'warning' : 'neutral', time }
}

/**
 * The Owner cell: the office person by name (B-TH-016, Owner decision 4: office people are named; floor workers never keep a
 * request), "A colleague" only when the API could not name them, nobody when nobody keeps it.
 */
export const assigneePhrase = (row: Pick<InquiryRow, 'assigneeId' | 'mine'> & { readonly assignee?: { readonly name: string } | null }): Phrase =>
  row.assigneeId === null ? { key: 'assignee.nobody' } : row.assignee?.name ? { key: row.mine ? 'assignee.nameMe' : 'assignee.name', params: { name: row.assignee.name } } : { key: row.mine ? 'assignee.me' : 'assignee.other' }

/** B-TH-216 (list-F01): the Files cell — photos and documents counted, never named; null: no files.read there ("—"). */
export function filesPhrases(row: Pick<InquiryRow, 'fileCounts'>): Phrase[] | null {
  const files = row.fileCounts
  if (!files) return null
  if (files.photos === 0 && files.documents === 0) return [{ key: 'files.none' }]
  return [...(files.photos > 0 ? [{ key: 'files.photos', params: { count: files.photos } }] : []), ...(files.documents > 0 ? [{ key: 'files.documents', params: { count: files.documents } }] : [])]
}

/**
 * B-TH-216 (band-F03): what Export ▾ says the file holds — the view. B-TH-233 (L2-G07): the file pages Incoming's one read to its
 * end (every kind of row the reader may open), so the "first 200 rows" note went; the target price is left out without the grain,
 * and a file with prospects' names holds personal data (said always: the reader cannot see every page before exporting).
 */
export function exportPhrases(tile: ListTile, can: Pick<InquiriesCan, 'price'>): { readonly heading: Phrase; readonly note: Phrase } {
  return { heading: { key: 'export.heading', params: { view: `tile.${tile}` } }, note: { key: can.price ? 'export.note' : 'export.notePrice' } }
}

// ---- verbs held with the reason ----------------------------------------------------------------------------------------------

export const KNOWN_REFUSALS: readonly string[] = INQUIRY_REFUSALS

/** A refusal said in our words: its code (else `refusal.other`). */
export const refusalPhrase = (code: string | null | undefined, number?: string): Phrase => ({ key: code && KNOWN_REFUSALS.includes(code) ? `refusal.${code}` : 'refusal.other', params: number ? { number } : undefined })

const factsOf = (row: Pick<InquiryRow, 'number' | 'status' | 'assigneeId' | 'party'>) => ({ number: row.number, status: row.status, assigneeId: row.assigneeId, partyId: row.party?.id ?? null })

export type RowVerb = 'quote' | 'assign' | 'askInfo' | 'decline'

/** Why a verb on a row (or the record) is held now, in words, or null: the rule's own check first, then the right, then offline. */
export function verbHeld(row: Pick<InquiryRow, 'number' | 'status' | 'assigneeId' | 'party'>, verb: RowVerb, can: InquiriesCan, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }
  const facts = factsOf(row)
  const refusal = verb === 'quote' ? quoteRefusal(facts) : verb === 'assign' ? (isClosed(row.status) ? { code: 'CLOSED' } : null) : verb === 'askInfo' ? askInfoRefusal(facts) : declineRefusal(facts, 'PRICE', null)
  if (refusal) return refusalPhrase(refusal.code, row.number)
  if (verb === 'quote' && !can.quotes) return { key: 'held.right', params: { right: 'right.quotes.manage' } }
  if (offline) return { key: 'held.offline' }
  return null
}

/** Assign to someone: refused when it is closed or already theirs (factory-domain assignRefusal). */
export function assignHeld(row: Pick<InquiryRow, 'number' | 'status' | 'assigneeId' | 'party'>, assigneeId: string): Phrase | null {
  const refusal = assignRefusal(factsOf(row), assigneeId)
  return refusal ? refusalPhrase(refusal.code, row.number) : null
}

/** One record's verb from its `actions` (the API's own answer for this reader), with the right and offline. */
export function actionHeld(view: InquiryView, action: keyof InquiryView['actions'], can: InquiriesCan, offline: boolean): Phrase | null {
  const state = view.actions[action]
  if (!can.manage) return { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }
  // B-TH-025 / B-TH-026: Make order and Make style draft are optional in the answer (always sent by the API).
  if (!state) return { key: 'held.notNow' }
  if (!state.allowed)
    return state.refusal
      ? refusalPhrase(state.refusal.code, view.number)
      : action === 'quote' && !can.quotes
        ? { key: 'held.right', params: { right: 'right.quotes.manage' } }
        : action === 'order' && !can.orders // B-TH-228
          ? { key: 'held.right', params: { right: 'right.orders.manage' } }
          : { key: 'held.notNow' }
  if (offline) return { key: 'held.offline' }
  return null
}

// ---- B-TH-228 (threads plan TH-2; pane-actions-F02 / F04): Make order and Make style draft ----------------------------------

/**
 * Make style draft is the product office's action (product.styles.manage over the request's company): the production manager may,
 * so it is NOT held by the sales right. The API's own `actions.styleDraft` decides (closed, a prospect, the most drafts), then the
 * right, then offline.
 */
export function styleDraftHeld(view: InquiryView, can: InquiriesCan, offline: boolean): Phrase | null {
  const state = view.actions.styleDraft
  if (!can.stylesManage) return { key: 'held.needs', params: { right: 'right.product.styles.manage' } }
  if (!state) return { key: 'held.notNow' }
  if (!state.allowed) return state.refusal ? refusalPhrase(state.refusal.code, view.number) : { key: 'held.notNow' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** What Make order sends, as typed: a price per line (blank = the customer's list price), the promise date, their PO, the files. */
export interface OrderDraft {
  /** By the line's seq: the unit price typed (on the order's basis), '' = the list price. */
  readonly prices: Readonly<Record<number, string>>
  readonly promiseDate: string | null
  readonly customerRef: string
  readonly carryFiles: boolean
}

/** The dialog starts from the request: the price the customer was shown on each line (price grain only), their date and PO, files on. */
export function orderDraftOf(view: InquiryView, can: InquiriesCan): OrderDraft {
  const prices: Record<number, string> = {}
  for (const line of view.lines) prices[line.seq] = can.price && typeof line.unitPriceShown === 'string' ? line.unitPriceShown : ''
  return { prices, promiseDate: view.wantedDate, customerRef: view.customerRef ?? '', carryFiles: true }
}

/** A typed price as the API takes it (a decimal string, a comma accepted), or null when it is not one. */
export function priceOf(typed: string): string | null {
  const value = typed.trim().replace(',', '.')
  return /^\d{1,12}(\.\d{1,6})?$/.test(value) ? value : null
}

/** Why Make order waits (the API's own rule first, then a price that is not a price), or null. */
export function orderHeld(view: InquiryView, draft: OrderDraft, can: InquiriesCan, offline: boolean): Phrase | null {
  const held = actionHeld(view, 'order', can, offline)
  if (held) return held
  const bad = view.lines.find((line) => (draft.prices[line.seq] ?? '').trim() !== '' && priceOf(draft.prices[line.seq] ?? '') === null)
  if (bad) return { key: 'order.badPrice', params: { n: bad.seq / 10 } }
  return null
}

/** The Make order body: only the prices typed (a price is sent only with the price grain), the date, the PO, carrying the files. */
export function orderBodyOf(view: InquiryView, draft: OrderDraft, can: InquiriesCan): { version: number; lines?: Array<{ seq: number; unitPrice: string }>; promiseDate?: string | null; customerRef?: string; carryFiles: boolean } {
  const lines = can.price ? view.lines.flatMap((line) => { const price = priceOf(draft.prices[line.seq] ?? ''); return price ? [{ seq: line.seq, unitPrice: price }] : [] }) : []
  const ref = draft.customerRef.trim()
  return { version: view.version, ...(lines.length > 0 ? { lines } : {}), ...(draft.promiseDate !== view.wantedDate ? { promiseDate: draft.promiseDate } : {}), ...(ref ? { customerRef: ref } : {}), carryFiles: draft.carryFiles }
}

/**
 * A decision's receipt stays on the page when the queue moves on to the next request (the pane then shows another one): Make quote,
 * Make order (confirmed, or waiting for approval and why), Decline, Mark lost. A style draft leaves the request open: its receipt
 * stays in the pane.
 */
export const receiptStays = (key: string): boolean => key.startsWith('done.quote') || key.startsWith('done.order') || key === 'done.decline' || key === 'done.lost'

/** The request's files that may go with what is made from it (its own and its mail's), as the dialogs list them. */
export const carriableFiles = (view: Pick<InquiryView, 'files' | 'mailFiles'>): InquiryFile[] => [...view.files, ...view.mailFiles]

/** What Make order says when it is done: confirmed, or waiting for approval and why — never "confirmed" while it waits (L2-G06). */
export function orderDonePhrase(made: { order: { number: string; status: 'CONFIRMED' | 'PENDING_APPROVAL'; waitsFor: 'CREDIT' | 'APPROVAL' | null } }, number: string): Phrase {
  const params = { order: made.order.number, number }
  if (made.order.status === 'CONFIRMED') return { key: 'done.orderConfirmed', params }
  return { key: made.order.waitsFor === 'CREDIT' ? 'done.orderCredit' : 'done.orderApproval', params }
}

/** The style the request becomes a draft of, as typed. */
export interface StyleDraftDraft {
  readonly code: string
  readonly name: string
  readonly productType: string
  readonly sizeScaleId: string
  readonly season: string
  /** The request's files to carry to the style. */
  readonly fileIds: readonly string[]
}

/** The first line of the request, as a style's name starts (at most 200 characters). */
const subjectOf = (view: Pick<InquiryView, 'request' | 'number'>): string => (view.request.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? view.number).slice(0, 200)

export function styleDraftOf(view: InquiryView): StyleDraftDraft {
  return { code: '', name: subjectOf(view), productType: '', sizeScaleId: '', season: '', fileIds: carriableFiles(view).map((file) => file.id) }
}

/** The style library's code rule (factory-domain product/styles STYLE_CODE). */
const STYLE_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/

/** Why Make style draft waits (the API's rule and the right first, then the code and the product type), or null. */
export function styleDraftDialogHeld(view: InquiryView, draft: StyleDraftDraft, can: InquiriesCan, offline: boolean): Phrase | null {
  const held = styleDraftHeld(view, can, offline)
  if (held) return held
  if (!STYLE_CODE.test(draft.code.trim().toUpperCase())) return { key: 'styleDraft.held.code' }
  if (!draft.productType) return { key: 'styleDraft.held.type' }
  // The style library takes its range from a size scale (a product type alone gives none for most types): asked, never guessed.
  if (!draft.sizeScaleId) return { key: 'styleDraft.held.scale' }
  return null
}

export function styleDraftBodyOf(view: InquiryView, draft: StyleDraftDraft): { version: number; code: string; name?: string; productType: string; sizeScaleId?: string; season?: string; fileIds: string[] } {
  const name = draft.name.trim()
  const season = draft.season.trim()
  return { version: view.version, code: draft.code.trim().toUpperCase(), ...(name ? { name } : {}), productType: draft.productType, ...(draft.sizeScaleId ? { sizeScaleId: draft.sizeScaleId } : {}), ...(season ? { season } : {}), fileIds: [...draft.fileIds] }
}
// ---- end B-TH-228

// ---- the selection (Assign to…, Decline N) -------------------------------------------------------------------------------------

/**
 * What a bulk verb reaches: the open requests of the selection (at most the API's 100); closed ones are left out with why. B-TH-233
 * (list-F11): a selection over every kind — Assign and Decline act on requests only; a catalogue order or a change request is left
 * out and counted (`others`), each decided on its own (the pane, Home › Approvals). `selected` holds the rows' keys (`<kind>:<id>`).
 */
export function bulkReach(rows: readonly IncomingRow[], selected: readonly string[]): { readonly open: InquiryRow[]; readonly closed: number; readonly others: number; readonly held: Phrase | null } {
  const picked = rows.filter((row) => selected.includes(row.key))
  const requests = picked.flatMap((row) => (row.kind === 'REQUEST' && row.request ? [row.request] : []))
  const open = requests.filter((row) => isOpen(row.status))
  const closed = requests.length - open.length
  const others = picked.length - requests.length
  const held = open.length === 0 ? { key: others > 0 && requests.length === 0 ? 'bulk.noneRequests' : 'bulk.noneOpen' } : open.length > INQUIRY_LIMITS.bulk ? { key: 'bulk.tooMany', params: { max: INQUIRY_LIMITS.bulk } } : null
  return { open, closed, others, held }
}

// ---- the lines asked (a style in a colourway, or words; pieces by size or in all) -----------------------------------------------

/** The size grid's row of a line whose colour is not a colourway. */
export const ANY_COLOUR = '__any__'

export interface LineDraft {
  /** The draft's own key (a line has no id until it is saved). */
  readonly key: string
  readonly styleId: string | null
  /** "DEMO-JKT-01 · Demo touring jacket", kept for the picker while the style is read. */
  readonly styleLabel: string | null
  readonly colourwayId: string | null
  readonly colourText: string
  readonly description: string
  /** Pieces per size code of a style line (the DS size grid). */
  readonly sizes: Readonly<Record<string, number>>
  /** A line in words: its sizes typed as `50:5 52:10`. */
  readonly sizesText: string
  /** Pieces in all (when no sizes are given). */
  readonly quantity: string
  readonly note: string
}

let draftSeq = 0
export const newLineKey = (): string => `line-${++draftSeq}`

export const emptyLine = (key: string = newLineKey()): LineDraft => ({ key, styleId: null, styleLabel: null, colourwayId: null, colourText: '', description: '', sizes: {}, sizesText: '', quantity: '', note: '' })

export const sizesText = (sizes: Readonly<Record<string, number>>): string =>
  Object.entries(sizes)
    .map(([code, pieces]) => `${code}:${pieces}`)
    .join(' ')

/** `50:5 52:10` (or with `=` / `x`, commas) → pieces per size; null when it does not read as sizes. */
export function parseSizes(text: string): Record<string, number> | null {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  const sizes: Record<string, number> = {}
  for (const part of trimmed.split(/[\s,;]+/).filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9./+-]{0,19})[:=x×]([0-9]{1,6})$/.exec(part)
    if (!match) return null
    const [, code, pieces] = match
    const n = Number(pieces)
    if (!SIZE_CODE.test(code!) || !Number.isInteger(n) || n < 1 || n > INQUIRY_LIMITS.sizePieces) return null
    sizes[code!] = (sizes[code!] ?? 0) + n
  }
  return sizes
}

export function lineDraftsOf(lines: readonly InquiryLine[]): LineDraft[] {
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      key: line.id,
      styleId: line.style?.id ?? null,
      styleLabel: line.style ? `${line.style.code} · ${line.style.name}` : null,
      colourwayId: line.colourway?.id ?? null,
      colourText: line.colourText ?? '',
      description: line.description ?? '',
      sizes: line.style ? line.sizes : {},
      sizesText: line.style ? '' : sizesText(line.sizes),
      quantity: Object.keys(line.sizes).length === 0 && line.quantity !== null ? String(line.quantity) : '',
      note: line.note ?? '',
    }))
}

const blank = (value: string): boolean => value.trim() === ''
const piecesIn = (sizes: Readonly<Record<string, number>>): number => Object.values(sizes).reduce((sum, pieces) => sum + pieces, 0)

/** A line's sizes as it will be sent (a style line: the grid's; else the typed ones), or null when they do not read. */
export function lineSizes(line: LineDraft): Record<string, number> | null {
  if (line.styleId) return Object.fromEntries(Object.entries(line.sizes).filter(([, pieces]) => pieces > 0))
  return parseSizes(line.sizesText)
}

/** A line's problems, in our words (factory-domain's lineProblems said first, by place). */
export function lineProblem(line: LineDraft): Phrase | null {
  if (!line.styleId && blank(line.description)) return { key: 'line.problem.styleOrWords' }
  const sizes = lineSizes(line)
  if (sizes === null) return { key: 'line.problem.sizes' }
  if (Object.keys(sizes).length > INQUIRY_LIMITS.sizes) return { key: 'line.problem.tooManySizes', params: { max: INQUIRY_LIMITS.sizes } }
  const total = piecesIn(sizes)
  if (!blank(line.quantity)) {
    const n = Number(line.quantity.trim())
    if (!Number.isInteger(n) || n < 1 || n > INQUIRY_LIMITS.quantity) return { key: 'line.problem.quantity', params: { max: INQUIRY_LIMITS.quantity } }
    if (total > 0 && n !== total) return { key: 'line.problem.quantitySum', params: { total } }
  }
  if (total > INQUIRY_LIMITS.quantity) return { key: 'line.problem.quantity', params: { max: INQUIRY_LIMITS.quantity } }
  return null
}

/** The line as the API takes it (null fields left out on a new inquiry, sent as null on Apply). */
export function lineBodyOf(line: LineDraft): LineBody {
  const sizes = lineSizes(line) ?? {}
  const quantity = blank(line.quantity) ? null : Number(line.quantity.trim())
  return {
    styleId: line.styleId,
    colourwayId: line.styleId ? line.colourwayId : null,
    colourText: blank(line.colourText) ? null : line.colourText.trim(),
    description: blank(line.description) ? null : line.description.trim(),
    ...(Object.keys(sizes).length > 0 ? { sizes } : {}),
    quantity: Object.keys(sizes).length > 0 ? null : quantity,
    note: blank(line.note) ? null : line.note.trim(),
  }
}

/** A line nobody filled (no style, no words, no pieces): left out of what is sent. */
export const isBlankLine = (line: LineDraft): boolean => !line.styleId && blank(line.description) && blank(line.sizesText) && blank(line.quantity) && blank(line.note) && blank(line.colourText)

export const linePieces = (line: LineDraft): number => {
  const sizes = lineSizes(line)
  const total = sizes ? piecesIn(sizes) : 0
  if (total > 0) return total
  const n = Number(line.quantity.trim())
  return Number.isInteger(n) && n > 0 ? n : 0
}

// ---- money (the target price: a price) ----------------------------------------------------------------------------------------

/** A target price typed in either language (`12,50`, `1.250,00`, `12.5`) → the API's decimal string, or null when it does not read. */
export function parsePrice(text: string): string | null {
  const trimmed = text.trim().replace(/\s/g, '')
  if (trimmed === '') return null
  let normal = trimmed
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(normal)) normal = normal.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(normal)) normal = normal.replace(/,/g, '')
  else normal = normal.replace(',', '.')
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(normal)) return null
  return normal
}

/** A price the API sent (`12.500000`) as typed back (`12.50`). */
export function priceEditText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return n.toFixed(Math.max(2, (value.split('.')[1] ?? '').replace(/0+$/, '').length))
}

/** A unit price in the reader's language. */
export function priceText(value: string, currency: string, locale: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${value} ${currency}`
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

const fractionDigits = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** An amount in minor units (the quote's value) in the reader's language. */
export function amountText(minor: number, currency: string, locale: string): string {
  const digits = fractionDigits(currency)
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits)
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`
  }
}

export const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF'] as const

// ---- the Request tab: the draft and what Apply sends ---------------------------------------------------------------------------

export interface ProspectDraft {
  readonly name: string
  readonly company: string
  readonly email: string
  readonly phone: string
}

export interface RequestDraft {
  readonly request: string
  readonly wantedDate: string | null
  readonly targetPrice: string
  readonly currency: string
  readonly note: string
  readonly contactId: string | null
  readonly prospect: ProspectDraft
  readonly lines: readonly LineDraft[]
  readonly techPackFileIds: readonly string[]
  readonly techPackVersion: string
}

export function requestDraftOf(view: InquiryView): RequestDraft {
  return {
    request: view.request,
    wantedDate: view.wantedDate,
    targetPrice: priceEditText((view.targetUnitPrice as string | null | undefined) ?? null),
    currency: view.currency,
    note: view.note ?? '',
    contactId: view.contact?.id ?? null,
    prospect: { name: view.prospectDetails?.name ?? '', company: view.prospectDetails?.company ?? '', email: view.prospectDetails?.email ?? '', phone: view.prospectDetails?.phone ?? '' },
    lines: lineDraftsOf(view.lines),
    techPackFileIds: view.techPack.files.map((file) => file.named.id),
    techPackVersion: view.techPack.version ?? '',
  }
}

const sameLines = (a: readonly LineDraft[], b: readonly LineDraft[]): boolean => JSON.stringify(a.filter((line) => !isBlankLine(line)).map(lineBodyOf)) === JSON.stringify(b.filter((line) => !isBlankLine(line)).map(lineBodyOf))
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])
const prospectBodyOf = (prospect: ProspectDraft) => ({ name: blank(prospect.name) ? null : prospect.name.trim(), company: blank(prospect.company) ? null : prospect.company.trim(), email: blank(prospect.email) ? null : prospect.email.trim(), phone: blank(prospect.phone) ? null : prospect.phone.trim() })
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^\+?[0-9][0-9 ()./-]{2,38}$/

/** A prospect's own problems (factory-domain prospectProblems said first). */
export function prospectProblem(prospect: ProspectDraft): Phrase | null {
  if (blank(prospect.name) && blank(prospect.company) && blank(prospect.email)) return { key: 'prospect.problem.who' }
  if (!blank(prospect.email) && !EMAIL.test(prospect.email.trim())) return { key: 'prospect.problem.email' }
  if (!blank(prospect.phone) && !PHONE.test(prospect.phone.trim())) return { key: 'prospect.problem.phone' }
  return null
}

export interface RequestChanges {
  /** How many fields changed (the EditModeBar's count). */
  readonly count: number
  /** What Apply sends (with the version); null when nothing changed. */
  readonly body: UpdateInquiryBody | null
  /** Why Apply is held (a field that does not read), else null. */
  readonly problem: Phrase | null
}

/** What changed between the inquiry as read and the draft, and the PATCH body: only what changed; a closed inquiry only its note. */
export function requestChanges(view: InquiryView, draft: RequestDraft, can: Pick<InquiriesCan, 'price'>): RequestChanges {
  const was = requestDraftOf(view)
  const open = isOpen(view.status)
  const body: Record<string, unknown> = {}
  let problem: Phrase | null = null
  if (draft.note.trim() !== was.note.trim()) body.note = blank(draft.note) ? null : draft.note.trim()
  if (open) {
    if (draft.request.trim() !== was.request.trim()) {
      if (blank(draft.request)) problem ??= { key: 'request.problem.request' }
      else body.request = draft.request.trim()
    }
    if (draft.wantedDate !== was.wantedDate) body.wantedDate = draft.wantedDate
    if (can.price && (draft.targetPrice.trim() !== was.targetPrice.trim() || draft.currency !== was.currency)) {
      const price = parsePrice(draft.targetPrice)
      if (!blank(draft.targetPrice) && price === null) problem ??= { key: 'request.problem.price' }
      else {
        if (draft.targetPrice.trim() !== was.targetPrice.trim()) body.targetUnitPrice = price
        if (draft.currency !== was.currency) body.currency = draft.currency
      }
    } else if (!can.price && draft.currency !== was.currency) body.currency = draft.currency
    // B-TH-234: a prospect gets its customer only through "Make or match the customer" (the check first, W23), never by a PATCH here.
    if (draft.contactId !== was.contactId && view.party) body.contactId = draft.contactId
    const wasProspect = prospectBodyOf(was.prospect)
    const nowProspect = prospectBodyOf(draft.prospect)
    if (!view.party && !view.prospectDetails?.erased && JSON.stringify(wasProspect) !== JSON.stringify(nowProspect)) {
      const prospectIssue = prospectProblem(draft.prospect)
      if (prospectIssue) problem ??= prospectIssue
      else body.prospect = nowProspect
    }
    if (!sameLines(was.lines, draft.lines)) {
      const lines = draft.lines.filter((line) => !isBlankLine(line))
      const issue = lines.map(lineProblem).find((one) => one !== null) ?? null
      if (issue) problem ??= { key: 'line.problem.at', params: { n: lines.findIndex((line) => lineProblem(line) !== null) + 1, problem: issue.key } }
      else if (lines.length > INQUIRY_LIMITS.lines) problem ??= { key: 'line.problem.tooMany', params: { max: INQUIRY_LIMITS.lines } }
      else body.lines = lines.map(lineBodyOf)
    }
    if (!sameIds(was.techPackFileIds, draft.techPackFileIds)) body.techPackFileIds = [...draft.techPackFileIds]
    if (draft.techPackVersion.trim() !== was.techPackVersion.trim()) body.techPackVersion = blank(draft.techPackVersion) ? null : draft.techPackVersion.trim()
  }
  const count = Object.keys(body).length + (problem ? 1 : 0)
  if (Object.keys(body).length === 0) return { count: problem ? 1 : 0, body: null, problem }
  return { count, body: { version: view.version, ...body } as UpdateInquiryBody, problem }
}

/** The tech pack chosen in the draft: a file of the inquiry or of its mail (each once). */
export function toggleTechPack(draft: RequestDraft, fileId: string, on: boolean): RequestDraft {
  const ids = draft.techPackFileIds.filter((id) => id !== fileId)
  return { ...draft, techPackFileIds: on ? [...ids, fileId] : ids }
}

// ---- New request (typed, or from a mail): new-request.ts (B-TH-221) ------------------------------------------------------------

// ---- Decline, Lost, Make quote ----------------------------------------------------------------------------------------------

export interface DeclineDraft {
  readonly reason: DeclineReason | null
  readonly note: string
  /** The message to the customer (optional). B-TH-234 (B-TH-043): it goes in the decline's own command, only when `send` is ticked. */
  readonly message: string
  /** B-TH-234: "Send to the customer" (off until ticked: nothing goes unless ticked). */
  readonly send?: boolean
}

export const emptyDecline: DeclineDraft = { reason: null, note: '', message: '', send: false }

/** Why Decline is held: a reason; OTHER says it in words (factory-domain OTHER_NEEDS_WORDS). B-TH-234: a ticked message needs words; "Not an order" sends nothing. */
export function declineHeld(draft: DeclineDraft, offline: boolean): Phrase | null {
  if (!draft.reason) return { key: 'decline.held.reason' }
  if (draft.reason === 'OTHER' && blank(draft.note)) return { key: 'refusal.OTHER_NEEDS_WORDS' }
  if (draft.note.trim().length > INQUIRY_LIMITS.closeNote) return { key: 'decline.held.long', params: { max: INQUIRY_LIMITS.closeNote } }
  // B-TH-234
  if (draft.send && draft.reason === 'NOT_AN_ORDER') return { key: 'refusal.SENDS_NOTHING' }
  if (draft.send && blank(draft.message)) return { key: 'decline.held.message' }
  if (offline) return { key: 'held.offline' }
  return null
}

/**
 * Who the decline's message reaches, or why it cannot be sent. B-TH-234 (B-TH-043): the request answers where its message goes
 * (`messageTo`): PORTAL — the customer reads it in its portal; MAIL — to the request's contact (`to`), in the customer's language;
 * none with the refusal (a prospect: make the customer first). A mail needs email.send. The message never goes to anyone else.
 */
export interface MessageReach {
  readonly to: string | null
  readonly via: 'PORTAL' | 'MAIL' | null
  /** The customer's language (its contact's, else its own): the dialog says to write in it. */
  readonly language: string | null
  readonly held: Phrase | null
}

export function messageReach(view: Pick<InquiryView, 'party' | 'contact' | 'number' | 'messageTo'> | null, can: Pick<InquiriesCan, 'email' | 'thread'>): MessageReach {
  if (!view) return { to: null, via: null, language: null, held: { key: 'decline.message.many' } }
  const known = view.messageTo
  if (known) {
    if (known.refusal) return { to: null, via: null, language: known.language, held: refusalPhrase(known.refusal.code, view.number) }
    if (known.via === null) return { to: null, via: null, language: known.language, held: { key: 'decline.message.prospect' } }
    if (known.via === 'MAIL' && (!can.email || !can.thread)) return { to: null, via: 'MAIL', language: known.language, held: { key: 'held.right', params: { right: 'right.email.send' } } }
    if (known.via === 'MAIL' && known.to.length === 0) return { to: null, via: 'MAIL', language: known.language, held: { key: 'decline.message.noEmail' } }
    return { to: known.via === 'MAIL' ? known.to.join(', ') : null, via: known.via, language: known.language, held: null }
  }
  // An answer without `messageTo` (typed demo data of before): the request's contact by mail.
  if (!can.email || !can.thread) return { to: null, via: null, language: null, held: { key: 'held.right', params: { right: 'right.email.send' } } }
  if (!view.party) return { to: null, via: null, language: null, held: { key: 'decline.message.prospect' } }
  if (!view.contact?.email) return { to: null, via: null, language: null, held: { key: 'decline.message.noEmail' } }
  return { to: view.contact.email, via: 'MAIL', language: null, held: null }
}

/** B-TH-234: the decline's body — the message only when ticked, reachable and not "Not an order" (bulk never sends: its own body). */
export function declineBodyOf(view: Pick<InquiryView, 'version' | 'party' | 'contact' | 'number' | 'messageTo'>, draft: DeclineDraft, can: Pick<InquiriesCan, 'email' | 'thread'>): { version: number; reason: DeclineReason; note?: string; message?: { body: string } } | null {
  if (!draft.reason) return null
  const note = draft.note.trim()
  const message = draft.send && draft.reason !== 'NOT_AN_ORDER' && !messageReach(view, can).held ? draft.message.trim() : ''
  return { version: view.version, reason: draft.reason, ...(note ? { note } : {}), ...(message ? { message: { body: message } } : {}) }
}

export const lostHeld = (note: string, offline: boolean): Phrase | null => (blank(note) ? { key: 'lost.held.note' } : note.trim().length > INQUIRY_LIMITS.closeNote ? { key: 'decline.held.long', params: { max: INQUIRY_LIMITS.closeNote } } : offline ? { key: 'held.offline' } : null)

export interface QuotePreview {
  /** The lines that become size-grid lines of the quote. */
  readonly copied: ReadonlyArray<{ readonly seq: number; readonly label: string; readonly pieces: number }>
  /** The lines left out and why (no style, no colourway, no sizes). */
  readonly leftOut: ReadonlyArray<{ readonly seq: number; readonly phrase: Phrase }>
}

const LEFT_OUT_REASON = (reason: string): string => (/style/i.test(reason) ? 'leftOut.noStyle' : /colourway/i.test(reason) ? 'leftOut.noColourway' : 'leftOut.noSizes')

/** What "Make quote" will copy from the inquiry's lines (factory-domain quotableLines: the same rule the API runs). */
export function quotePreview(view: Pick<InquiryView, 'lines'>): QuotePreview {
  const lines = view.lines.map((line) => ({ seq: line.seq, styleId: line.style?.id ?? null, colourwayId: line.colourway?.id ?? null, description: line.description, note: line.note, sizes: line.sizes }))
  const { copy, leftOut } = quotableLines(lines)
  const byseq = new Map(view.lines.map((line) => [line.seq, line]))
  return {
    copied: copy.map((line) => {
      const source = byseq.get(line.seq)!
      return { seq: line.seq, label: `${source.style?.code ?? ''}${source.colourway ? ` · ${source.colourway.code}` : ''}`, pieces: piecesIn(line.sizes) }
    }),
    leftOut: leftOut.map((one) => ({ seq: one.seq, phrase: { key: LEFT_OUT_REASON(one.reason), params: { n: one.seq / 10 } } })),
  }
}

/** The API's leftOut after the make: a size the colourway no longer offers by its size; a line by our preview's reason. */
export function leftOutPhrases(leftOut: ReadonlyArray<{ readonly seq: number; readonly size: string | null; readonly reason: string }>, preview: QuotePreview): Phrase[] {
  return leftOut.map((one) => {
    if (one.size !== null) return { key: 'leftOut.size', params: { n: one.seq / 10, size: one.size } }
    return preview.leftOut.find((line) => line.seq === one.seq)?.phrase ?? { key: LEFT_OUT_REASON(one.reason), params: { n: one.seq / 10 } }
  })
}

// ---- refusals and problems -------------------------------------------------------------------------------------------------------

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

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
  /** The API's places of a 400 (`body/lines/0/sizes` → `lines/0/sizes`). */
  readonly paths: readonly string[]
  /** Someone changed it first: read it again. */
  readonly stale: boolean
}

/** A refused write in words: a rule's refusal by its code, a stale version, a refused field, the kind. */
export function writeProblem(error: unknown, number?: string): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { ...refusalPhrase(code, number), paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: paths.some((path) => path.startsWith('items/')) ? 'problem.staleSome' : 'problem.stale', paths, stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

const KNOWN_FIELDS = ['request', 'wantedDate', 'targetUnitPrice', 'currency', 'note', 'techPackFileIds', 'techPackVersion', 'partyId', 'contactId', 'prospect', 'lines', 'assigneeId', 'receivedAt', 'reason', 'items', 'customerRef', 'companyId']

/** A 400's places in our words (`lines/0/sizes` → the field it names). */
export function fieldOfPath(path: string): Phrase {
  const top = path.split('/')[0] ?? ''
  if (top === 'lines') {
    const index = Number(path.split('/')[1])
    return Number.isInteger(index) ? { key: 'field.lineAt', params: { n: index + 1 } } : { key: 'field.lines' }
  }
  return { key: KNOWN_FIELDS.includes(top) ? `field.${top}` : 'field.other' }
}

/** The places a refusal named, once each, in our words. */
export const fieldLines = (paths: readonly string[]): Phrase[] => {
  const seen = new Set<string>()
  const out: Phrase[] = []
  for (const path of paths) {
    const phrase = fieldOfPath(path)
    const id = `${phrase.key}:${JSON.stringify(phrase.params ?? {})}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(phrase)
  }
  return out
}

/** A day in the business calendar (YYYY-MM-DD) in the site's zone. */
export const todayOf = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

/** The list's ids in the order shown (J / K walks them). B-TH-233: the rows that open beside the list (a change request opens Home › Approvals). */
export const navIdsOf = (list: Pick<IncomingList, 'rows'> | null): string[] => (list ? list.rows.filter((row) => row.opens.place === 'INCOMING').map((row) => row.id) : [])

/** The next inquiry after a decision (the queue moves on), else null. */
export function nextAfter(ids: readonly string[], current: string): string | null {
  const index = ids.indexOf(current)
  if (index < 0) return ids[0] ?? null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

// ---- B-TH-233 (threads plan TH-3, G2, L2-G07; O-SAL-INQ-LIST.list-F01/F05/F11/F14, .tiles-F03): the rows of every kind ----------

/**
 * Where a row opens (list-F11: each kind follows its own view right — the API lists a row only to a reader who may open it):
 *   request    beside the list, the reading pane with its thread (`?open=<id>`)
 *   catalogue  a catalogue order beside the list, its pane with its thread (B-TH-040; `?catalogue=<id>`)
 *   approvals  a change or cancel request (agreement T3, `opens.place` APPROVALS): Home › Approvals, where it is answered
 */
export type RowPlace = 'request' | 'catalogue' | 'approvals'
export const placeOf = (row: Pick<IncomingRow, 'kind' | 'opens'>): RowPlace => (row.opens.place === 'APPROVALS' ? 'approvals' : row.kind === 'CATALOGUE_ORDER' ? 'catalogue' : 'request')

/**
 * Home › Approvals for a change request (agreement T3). Approvals' review window (`?open=`) reads the approval engine's tasks only
 * (areas/home/approvals/Approvals.tsx), so a change request's id would open "not found" there: the door opens Approvals on its kind
 * — the change requests waiting, each opening its order — until Approvals opens one by its id (then `&open=<opens.id>`, one line).
 */
export const approvalsHref = (prefix: string): string => `${prefix}/home/approvals?kind=ORDER_CHANGE_REQUEST`

/** The address a row opens at — a real link (⌘-click: a new tab): the pane beside the list, or Home › Approvals. */
export function rowHref(prefix: string, address: ListAddress, row: Pick<IncomingRow, 'kind' | 'id' | 'opens'>): string {
  const place = placeOf(row)
  if (place === 'approvals') return approvalsHref(prefix)
  return listHref(prefix, { ...address, isNew: false, mail: null, open: place === 'request' ? row.id : null, catalogue: place === 'catalogue' ? row.id : null, tab: 'request' })
}

/** The record type of a row's thread (its New messages, B-TH-230): a request, a catalogue order, a change request. */
export const THREAD_TYPE: Readonly<Record<IncomingKind, string>> = Object.freeze({ REQUEST: 'Inquiry', CATALOGUE_ORDER: 'PortalOrderRequest', CHANGE_REQUEST: 'OrderChangeRequest' })

/** The state's tone: a request by its status; a catalogue order or change request waiting (SENT, OPEN) informs, accepted succeeds. */
export function stateTone(row: Pick<IncomingRow, 'kind' | 'state' | 'request'>): Tone {
  if (row.kind === 'REQUEST' && row.request) return STATUS_TONE[row.request.status]
  if (row.state === 'SENT' || row.state === 'OPEN') return 'info'
  return row.state === 'ACCEPTED' ? 'success' : 'neutral'
}

/** The row's own facts beside its summary: a catalogue order's lines, a change request's order (what it changes). */
export function kindFacts(row: Pick<IncomingRow, 'catalogueOrder' | 'changeRequest'>): Phrase | null {
  if (row.catalogueOrder) return { key: 'kindFacts.catalogue', params: { count: row.catalogueOrder.lines, lines: row.catalogueOrder.lines, ref: row.catalogueOrder.customerRef ?? '—' } }
  if (row.changeRequest) return { key: `kindFacts.change.${row.changeRequest.kind}`, params: { order: row.changeRequest.order.number } }
  return null
}

/** list-F12: numbers repeat per company — a reader of several companies reads "INQ-0042 · CO2" (the name on hover). */
export const numberWithCompany = (number: string, companyCode: string | null, many: boolean): string => (many && companyCode ? `${number} · ${companyCode}` : number)

/** A request's row as Incoming reads it (the design cases and tests: the API sends Incoming rows; a request keeps its whole row). */
export function incomingRowOf(row: InquiryRow): IncomingRow {
  return {
    key: `REQUEST:${row.id}`,
    kind: 'REQUEST',
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    receivedAt: row.receivedAt,
    party: row.party,
    fromWords: row.fromWords,
    prospect: row.prospect,
    summary: row.summary,
    pieces: row.pieces > 0 ? row.pieces : null,
    wantedDate: row.wantedDate,
    state: row.status,
    stateWords: stateWords('REQUEST', row.status, row.declineReason),
    open: isOpen(row.status),
    waiting: row.waiting,
    version: row.version,
    opens: { place: 'INCOMING', id: row.id },
    request: row,
    catalogueOrder: null,
    changeRequest: null,
  }
}

/** The rows the page holds: the first page and every page "Show more" read after it, each row once (a row that moved is kept where it was first read). */
export function mergePages(pages: ReadonlyArray<Pick<IncomingList, 'rows'>>): IncomingRow[] {
  const seen = new Set<string>()
  const rows: IncomingRow[] = []
  for (const page of pages)
    for (const row of page.rows) {
      if (seen.has(row.key)) continue
      seen.add(row.key)
      rows.push(row)
    }
  return rows
}

// ---- "Customer replies" (list-F14, B-TH-047): the one office inbox of conversations waiting on us ----------------------------------

/**
 * Where a Customer replies row opens: its record's own page (or its panels) at the message that waits (`?message=<id>`, the bell's
 * anchor: the thread scrolls to it and opens). The row was listed only because the reader may open that record (threads.read AND
 * the record's own view permission, checked by the API row by row).
 */
export function replyHref(prefix: string, row: Pick<WaitingRow, 'recordType' | 'recordId' | 'label' | 'companyId' | 'lastMessage'>, built: ReadonlySet<string>): string {
  const address = recordAddress({ type: row.recordType, id: row.recordId, label: row.label, companyId: row.companyId, siteId: null }, built)
  return `${prefix}${address}${address.includes('?') ? '&' : '?'}message=${encodeURIComponent(row.lastMessage.id)}`
}

/** How long a conversation waits on us, in working time (clock time when its company has no calendar), amber past the rule's days. */
export function replyWaiting(row: Pick<WaitingRow, 'waiting'>): { readonly time: Phrase; readonly amber: boolean; readonly clock: boolean } {
  return { time: workingTime(row.waiting.workingMinutes), amber: row.waiting.amber, clock: !row.waiting.calendar }
}

/** The record's kind in words (`recordType.<type>`), else the record's own label alone (a type without words says nothing more). */
export const REPLY_RECORD_TYPES = ['SalesOrder', 'Quote', 'Invoice', 'PaymentReminder', 'Shipment', 'Ddt', 'ReturnAuthorisation', 'RepairOrder', 'Complaint', 'SampleRound', 'ServiceCase', 'ProductSafetyReport', 'Style', 'Certificate', 'Capa', 'MeasurementProfile', 'Party', 'ChangeRequest', 'ApprovalRequest'] as const
export const replyTypeKey = (recordType: string): string | null => ((REPLY_RECORD_TYPES as readonly string[]).includes(recordType) ? `recordType.${recordType}` : null)
// ---- end B-TH-233

// ---- B-TH-234 (threads plan TH-3; pane-actions-F08, on B-TH-042): answer a new customer — match or make it from the prospect ------

/** What the person picked in "Make or match the customer": one of the customers the check found, or a new one from the prospect. */
export type CustomerChoice =
  | { readonly mode: 'match'; readonly partyId: string; readonly contactId: string | null; readonly addContact: boolean }
  | { readonly mode: 'make'; readonly code: string; readonly legalName: string; readonly kind: 'ORGANISATION' | 'PERSON'; readonly status: 'PROSPECT' | 'ACTIVE' }

/**
 * The dialog starts from the check: ONE customer found by one of its contacts' own address (and no second one) is picked; nobody
 * found → a new customer from the prospect (the suggestion); anything else waits for the person's pick (W23: never a silent guess).
 */
export function customerChoiceOf(check: CustomerCheck): CustomerChoice | null {
  const byContact = check.candidates.filter((candidate) => candidate.matchedBy === 'CONTACT')
  if (!check.ambiguous && check.candidates.length === 1 && byContact.length === 1) return { mode: 'match', partyId: byContact[0]!.party.id, contactId: byContact[0]!.contact?.id ?? null, addContact: false }
  if (check.candidates.length === 0 && check.make.allowed) return { mode: 'make', code: check.suggestion.code, legalName: check.suggestion.legalName, kind: check.suggestion.kind, status: 'PROSPECT' }
  return null
}

/** Picking a customer asks first unless it was found by its own contact's address alone; a new customer asks first while any was found. */
export function customerAsksFirst(check: CustomerCheck, choice: CustomerChoice | null): boolean {
  if (!choice) return false
  if (choice.mode === 'make') return check.candidates.length > 0
  const candidate = check.candidates.find((one) => one.party.id === choice.partyId)
  return !(candidate?.matchedBy === 'CONTACT' && !check.ambiguous)
}

const PARTY_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/

/** Why the pick waits, in words: the right, the API's own check (match / make), the code and name, the person's yes, offline. */
export function customerHeld(check: CustomerCheck, choice: CustomerChoice | null, confirmed: boolean, can: Pick<InquiriesCan, 'manage'>, offline: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }
  if (!choice) return { key: 'customer.held.pick' }
  const gate = choice.mode === 'make' ? check.make : check.match
  if (!gate.allowed) return gate.refusal ? refusalPhrase(gate.refusal.code) : choice.mode === 'make' ? { key: 'held.needs', params: { right: 'right.parties.manage' } } : { key: 'held.notNow' }
  if (choice.mode === 'make' && !PARTY_CODE.test(choice.code.trim())) return { key: 'customer.held.code' }
  if (choice.mode === 'make' && blank(choice.legalName)) return { key: 'customer.held.name' }
  if (customerAsksFirst(check, choice) && !confirmed) return { key: 'customer.held.confirm' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** The body of POST …/customer: the pick, and `confirmed` only when the check asks first. */
export function customerBodyOf(view: Pick<InquiryView, 'version'>, check: CustomerCheck, choice: CustomerChoice, confirmed: boolean): MakeCustomerBody {
  const yes = customerAsksFirst(check, choice) && confirmed ? { confirmed: true } : {}
  if (choice.mode === 'match') return { version: view.version, match: { partyId: choice.partyId, ...(choice.contactId ? { contactId: choice.contactId } : {}), ...(choice.addContact ? { addContact: true } : {}) }, ...yes }
  return { version: view.version, make: { code: choice.code.trim().toUpperCase(), legalName: choice.legalName.trim(), kind: choice.kind, status: choice.status }, ...yes }
}

/** The receipt: what happened (a match, a new contact, a new customer), and whether the mail the request came from joined the thread. */
export function customerDone(made: Pick<CustomerMade, 'made' | 'party' | 'mailJoined'>, number: string): { readonly phrase: Phrase; readonly lines: Phrase[] } {
  const params = { customer: made.party.name, number }
  const phrase: Phrase = { key: made.made === 'CUSTOMER' ? 'done.customerMade' : made.made === 'CONTACT' ? 'done.customerContact' : 'done.customerMatched', params }
  return { phrase, lines: made.mailJoined ? [{ key: 'done.mailJoined' }] : [] }
}

// ---- B-TH-234 (B-TH-051): "Ask <customer> for…" a document, an answer or measurements, by a date — a task in its portal ------------

export interface TaskDraft {
  readonly kind: RequestTaskKind | null
  /** The due day (YYYY-MM-DD, the site's day), or null: no date. */
  readonly due: string | null
}

export const emptyTask: TaskDraft = { kind: null, due: null }

/** Why the task waits, in words: the right, a prospect (no portal yet), a closed request, the kind, a day in the past, offline. */
export function taskHeld(view: Pick<InquiryView, 'party' | 'status'>, draft: TaskDraft | null, can: Pick<InquiriesCan, 'tasks'>, offline: boolean, today: string): Phrase | null {
  if (!can.tasks) return { key: 'held.needs', params: { right: 'right.partners.tasks.manage' } }
  if (!view.party) return { key: 'task.held.prospect' }
  if (!isOpen(view.status)) return { key: 'task.held.closed' }
  if (draft && !draft.kind) return { key: 'task.held.kind' }
  if (draft?.due && draft.due <= today) return { key: 'task.held.due' }
  if (offline) return { key: 'held.offline' }
  return null
}

/** A task refusal the API names (`refusal/REQUEST_PROSPECT`, `REQUEST_CLOSED`) in the page's words, else the general refusal. */
export const TASK_REFUSALS = ['REQUEST_PROSPECT', 'REQUEST_CLOSED'] as const
export const taskRefusal = (code: string | null): Phrase | null => (code && (TASK_REFUSALS as readonly string[]).includes(code) ? { key: `task.refusal.${code}` } : null)
// ---- end B-TH-234
