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
import type { CreateInquiryBody, FromMailBody, LineBody, UpdateInquiryBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { InquiryLine, InquiryList, InquiryRow, InquiryView, MailDraft } from './api'

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
  }
}

/** The rights a held verb may name, each with words (`right.<permission>`). */
export const KNOWN_RIGHTS = ['sales.inquiries.manage', 'quotes.manage', 'email.send', 'files.upload', 'email.triage'] as const

// ---- the page's address ---------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['request', 'files', 'quote', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The tile of a page without one: the API's default (every open inquiry). */
export const DEFAULT_TILE: InquiryTile = 'OPEN'

export interface ListAddress {
  /** A tile = a saved filter (the API's own `tile`); OPEN when the address names none. */
  readonly tile: InquiryTile
  readonly source: InquirySource | null
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
}

export const HOME_ADDRESS: ListAddress = { tile: DEFAULT_TILE, source: null, party: null, prospect: false, q: '', open: null, tab: 'request', isNew: false, mail: null }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const idOf = (value: string | null): string | null => (value && UUID.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null }): ListAddress {
  const prospect = params.get('prospect') === '1'
  return {
    tile: oneOf(INQUIRY_TILES, params.get('tile')) ?? DEFAULT_TILE,
    source: oneOf(INQUIRY_SOURCES, params.get('source')),
    party: prospect ? null : idOf(params.get('party')),
    prospect,
    q: (params.get('q') ?? '').slice(0, 100),
    open: idOf(params.get('open')),
    tab: oneOf(RECORD_TABS, params.get('tab')) ?? 'request',
    isNew: params.get('new') === '1',
    mail: idOf(params.get('mail')),
  }
}

export function addressText(address: ListAddress): string {
  const params = new URLSearchParams()
  if (address.tile !== DEFAULT_TILE) params.set('tile', address.tile)
  if (address.source) params.set('source', address.source)
  if (address.prospect) params.set('prospect', '1')
  else if (address.party) params.set('party', address.party)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.open) params.set('open', address.open)
  if (address.open && address.tab !== 'request') params.set('tab', address.tab)
  if (address.isNew) params.set('new', '1')
  if (address.mail) params.set('mail', address.mail)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Anything narrowing the rows beyond the default tile. */
export const isFiltered = (address: ListAddress): boolean => address.tile !== DEFAULT_TILE || !!address.source || !!address.party || address.prospect || !!address.q.trim()

export const listHref = (prefix: string, address: Partial<ListAddress> = {}): string => `${prefix}/sales/inquiries${addressText({ ...HOME_ADDRESS, ...address })}`

/** The inquiry's full page (a new tab from its DetailModal; where a search result or a link opens it). */
export function recordHref(prefix: string, inquiryId: string, tab?: RecordTab): string {
  return `${prefix}/sales/inquiries/${encodeURIComponent(inquiryId)}${tab && tab !== 'request' ? `?tab=${tab}` : ''}`
}

export const recordTabOf = (params: { get(name: string): string | null }): RecordTab => oneOf(RECORD_TABS, params.get('tab')) ?? 'request'

/** The list query the API takes for an address. */
export function queryOf(address: ListAddress) {
  return {
    tile: address.tile,
    source: address.source,
    partyId: address.prospect ? null : address.party,
    prospect: address.prospect,
    q: address.q.trim(),
  }
}

// ---- tiles, chips and notices ---------------------------------------------------------------------------------------------

/** The design's tiles (saved filters), in its order. */
export const DESIGN_TILES = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK'] as const satisfies readonly InquiryTile[]
/** Rows ▾ (the saved rows), in the design's order: Mine, New, Need info, Quoted, Declined, All, and the rest. */
export const SAVED_ROWS = ['OPEN', 'MINE', 'NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'QUOTED', 'DECLINED', 'LOST', 'ALL'] as const satisfies readonly InquiryTile[]

/** A tile's number: the API's count under the filters; unknown is "—", never 0 (the design's rule). */
export function tileValue(list: InquiryList | null, tile: InquiryTile, failed: boolean): string {
  if (failed || !list) return '—'
  const value = list.counts[tile]
  return value === null || value === undefined ? '—' : String(value)
}

/** WAITING_US is counted on at most 1000 open inquiries: past that the API says the count is partial. */
export const tilePartial = (list: InquiryList | null, tile: InquiryTile): boolean => tile === 'WAITING_US' && !!list && !list.complete

export interface FilterChipModel {
  readonly id: 'tile' | 'source' | 'party' | 'prospect' | 'q'
  readonly label: Phrase
  readonly clear: Partial<ListAddress>
}

/** The filter row: each filter a chip with ✕ (a tile's chip too: one filter model). */
export function chipsOf(address: ListAddress, partyName: string | null): FilterChipModel[] {
  const chips: FilterChipModel[] = []
  if (address.tile !== DEFAULT_TILE) chips.push({ id: 'tile', label: { key: 'chip.tile', params: { tile: `tile.${address.tile}` } }, clear: { tile: DEFAULT_TILE } })
  if (address.source) chips.push({ id: 'source', label: { key: 'chip.source', params: { source: `source.${address.source}` } }, clear: { source: null } })
  if (address.prospect) chips.push({ id: 'prospect', label: { key: 'chip.prospect' }, clear: { prospect: false } })
  else if (address.party) chips.push({ id: 'party', label: partyName ? { key: 'chip.party', params: { name: partyName } } : { key: 'chip.partyUnknown' }, clear: { party: null } })
  if (address.q.trim()) chips.push({ id: 'q', label: { key: 'chip.q', params: { q: address.q.trim() } }, clear: { q: '' } })
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
export function pageNotices(list: InquiryList | null, limit: number, dismissed: ReadonlySet<string>): PageNotice[] {
  if (!list) return []
  const notices: PageNotice[] = []
  if (!list.complete) notices.push({ key: 'notice.partial', tone: 'warning', value: 'partial' })
  if (list.rows.length >= limit) notices.push({ key: 'notice.capped', params: { count: limit }, tone: 'warning', value: `capped:${limit}` })
  const prospects = list.rows.filter((row) => row.prospect && isOpen(row.status)).length
  if (prospects > 0) notices.push({ key: 'notice.prospects', params: { count: prospects }, tone: 'info', value: `prospects:${prospects}` })
  return notices.filter((notice) => !dismissed.has(`${notice.key}:${notice.value}`))
}

export const noticeKey = (notice: Pick<PageNotice, 'key' | 'value'>): string => `${notice.key}:${notice.value}`

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
  if (waiting.for === 'CUSTOMER') return { phrase: { key: 'waiting.customer' }, tone: 'warning', time }
  return { phrase: { key: waiting.overdue ? 'waiting.usOverdue' : 'waiting.us' }, tone: waiting.overdue ? 'danger' : 'neutral', time }
}

/** "You" / "A colleague" / nobody: a list never names a person (Owner answer W1). */
export const assigneePhrase = (row: Pick<InquiryRow, 'assigneeId' | 'mine'>): Phrase => ({ key: row.assigneeId === null ? 'assignee.nobody' : row.mine ? 'assignee.me' : 'assignee.other' })

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
  if (!state.allowed) return state.refusal ? refusalPhrase(state.refusal.code, view.number) : action === 'quote' && !can.quotes ? { key: 'held.right', params: { right: 'right.quotes.manage' } } : { key: 'held.notNow' }
  if (offline) return { key: 'held.offline' }
  return null
}

// ---- the selection (Assign to…, Decline N) -------------------------------------------------------------------------------------

/** What a bulk verb reaches: the open inquiries of the selection (at most the API's 100); closed ones are left out with why. */
export function bulkReach(rows: readonly InquiryRow[], selected: readonly string[]): { readonly open: InquiryRow[]; readonly closed: number; readonly held: Phrase | null } {
  const picked = rows.filter((row) => selected.includes(row.id))
  const open = picked.filter((row) => isOpen(row.status))
  const closed = picked.length - open.length
  const held = open.length === 0 ? { key: 'bulk.noneOpen' } : open.length > INQUIRY_LIMITS.bulk ? { key: 'bulk.tooMany', params: { max: INQUIRY_LIMITS.bulk } } : null
  return { open, closed, held }
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
  /** A prospect matched to a customer (once): the party it becomes. */
  readonly matchPartyId: string | null
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
    matchPartyId: null,
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
    if (draft.matchPartyId && !view.party) {
      body.partyId = draft.matchPartyId
      body.prospect = null
      if (draft.contactId) body.contactId = draft.contactId
    } else {
      if (draft.contactId !== was.contactId && view.party) body.contactId = draft.contactId
      const wasProspect = prospectBodyOf(was.prospect)
      const nowProspect = prospectBodyOf(draft.prospect)
      if (!view.party && !view.prospectDetails?.erased && JSON.stringify(wasProspect) !== JSON.stringify(nowProspect)) {
        const prospectIssue = prospectProblem(draft.prospect)
        if (prospectIssue) problem ??= prospectIssue
        else body.prospect = nowProspect
      }
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
  const count = Object.keys(body).filter((key) => key !== 'prospect' || !('partyId' in body)).length + (problem ? 1 : 0)
  if (Object.keys(body).length === 0) return { count: problem ? 1 : 0, body: null, problem }
  return { count, body: { version: view.version, ...body } as UpdateInquiryBody, problem }
}

/** The tech pack chosen in the draft: a file of the inquiry or of its mail (each once). */
export function toggleTechPack(draft: RequestDraft, fileId: string, on: boolean): RequestDraft {
  const ids = draft.techPackFileIds.filter((id) => id !== fileId)
  return { ...draft, techPackFileIds: on ? [...ids, fileId] : ids }
}

// ---- New inquiry (typed, or from a mail) ---------------------------------------------------------------------------------------

export type WhoKind = 'customer' | 'prospect'

export interface NewDraft {
  readonly source: TypedSource
  readonly who: WhoKind
  readonly partyId: string | null
  readonly contactId: string | null
  readonly prospect: ProspectDraft
  readonly request: string
  readonly lines: readonly LineDraft[]
  readonly targetPrice: string
  readonly currency: string
  readonly wantedDate: string | null
  readonly note: string
  readonly assignToMe: boolean
  /** From a mail: the mail's kept attachments named as the brand's tech pack. */
  readonly techPackFileIds: readonly string[]
  readonly techPackVersion: string
}

export const emptyNewDraft = (currency = 'EUR'): NewDraft => ({
  source: 'PHONE',
  who: 'customer',
  partyId: null,
  contactId: null,
  prospect: { name: '', company: '', email: '', phone: '' },
  request: '',
  lines: [],
  targetPrice: '',
  currency,
  wantedDate: null,
  note: '',
  assignToMe: false,
  techPackFileIds: [],
  techPackVersion: '',
})

/** The draft "Make an inquiry" starts from: the mail's sender as the customer (when Nexus knows them) or a prospect, its words. */
export function draftFromMail(mail: MailDraft, currency = 'EUR'): NewDraft {
  const base = emptyNewDraft(currency)
  return {
    ...base,
    who: mail.party ? 'customer' : 'prospect',
    partyId: mail.party?.id ?? null,
    contactId: mail.contactId,
    prospect: { name: mail.prospect?.name ?? '', company: mail.prospect?.company ?? '', email: mail.prospect?.email ?? '', phone: mail.prospect?.phone ?? '' },
    request: mail.request,
  }
}

/** Why Create inquiry is held, or null. */
export function newDraftHeld(draft: NewDraft, can: Pick<InquiriesCan, 'manage' | 'price'>, offline: boolean, fromMail: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }
  if (draft.who === 'customer' && !draft.partyId) return { key: 'new.held.customer' }
  if (draft.who === 'prospect') {
    const problem = prospectProblem(draft.prospect)
    if (problem) return problem
  }
  if (!fromMail && blank(draft.request)) return { key: 'new.held.request' }
  if (can.price && !blank(draft.targetPrice) && parsePrice(draft.targetPrice) === null) return { key: 'request.problem.price' }
  const lines = draft.lines.filter((line) => !isBlankLine(line))
  const index = lines.findIndex((line) => lineProblem(line) !== null)
  if (index >= 0) return { key: 'line.problem.at', params: { n: index + 1, problem: lineProblem(lines[index]!)!.key } }
  if (offline) return { key: 'held.offline' }
  return null
}

const optionalLines = (draft: NewDraft) => {
  const lines = draft.lines.filter((line) => !isBlankLine(line))
  return lines.length > 0 ? { lines: lines.map(lineBodyOf) } : {}
}
const who = (draft: NewDraft) =>
  draft.who === 'customer' && draft.partyId ? { partyId: draft.partyId, ...(draft.contactId ? { contactId: draft.contactId } : {}) } : { prospect: { ...prospectBodyOf(draft.prospect), lawfulBasis: 'CONTRACT' as const } }
const asked = (draft: NewDraft, can: Pick<InquiriesCan, 'price'>, me: string | null) => {
  const price = can.price ? parsePrice(draft.targetPrice) : null
  return {
    ...(draft.wantedDate ? { wantedDate: draft.wantedDate } : {}),
    ...(price !== null ? { targetUnitPrice: price } : {}),
    currency: draft.currency,
    ...(blank(draft.note) ? {} : { note: draft.note.trim() }),
    ...(blank(draft.techPackVersion) ? {} : { techPackVersion: draft.techPackVersion.trim() }),
    ...optionalLines(draft),
    ...(draft.assignToMe && me ? { assigneeId: me } : {}),
  }
}

/** POST /sales/inquiries: what New inquiry sends. */
export function newBodyOf(draft: NewDraft, companyId: string, can: Pick<InquiriesCan, 'price'>, me: string | null): CreateInquiryBody {
  return { companyId, source: draft.source, ...who(draft), request: draft.request.trim(), ...asked(draft, can, me) } as CreateInquiryBody
}

/** POST /sales/inquiries/from-mail/:id: what "Make an inquiry" sends (the MAIL's version). */
export function fromMailBodyOf(draft: NewDraft, mail: MailDraft, version: number, can: Pick<InquiriesCan, 'price'>, me: string | null, companyId: string | null): FromMailBody {
  return {
    version,
    ...(mail.companyId === null && companyId ? { companyId } : {}),
    ...who(draft),
    ...(blank(draft.request) ? {} : { request: draft.request.trim() }),
    ...(draft.techPackFileIds.length > 0 ? { techPackFileIds: [...draft.techPackFileIds] } : {}),
    ...asked(draft, can, me),
  } as FromMailBody
}

// ---- Decline, Lost, Make quote ----------------------------------------------------------------------------------------------

export interface DeclineDraft {
  readonly reason: DeclineReason | null
  readonly note: string
  /** The message to the customer (optional), sent through the inquiry's thread after the decline. */
  readonly message: string
}

export const emptyDecline: DeclineDraft = { reason: null, note: '', message: '' }

/** Why Decline is held: a reason; OTHER says it in words (factory-domain OTHER_NEEDS_WORDS). */
export function declineHeld(draft: DeclineDraft, offline: boolean): Phrase | null {
  if (!draft.reason) return { key: 'decline.held.reason' }
  if (draft.reason === 'OTHER' && blank(draft.note)) return { key: 'refusal.OTHER_NEEDS_WORDS' }
  if (draft.note.trim().length > INQUIRY_LIMITS.closeNote) return { key: 'decline.held.long', params: { max: INQUIRY_LIMITS.closeNote } }
  if (offline) return { key: 'held.offline' }
  return null
}

/** Who the decline's message reaches, or why it cannot be sent (the thread mails the inquiry's customer only). */
export function messageReach(view: Pick<InquiryView, 'party' | 'contact'> | null, can: Pick<InquiriesCan, 'email' | 'thread'>): { readonly to: string | null; readonly held: Phrase | null } {
  if (!view) return { to: null, held: { key: 'decline.message.many' } }
  if (!can.email || !can.thread) return { to: null, held: { key: 'held.right', params: { right: 'right.email.send' } } }
  if (!view.party) return { to: null, held: { key: 'decline.message.prospect' } }
  if (!view.contact?.email) return { to: null, held: { key: 'decline.message.noEmail' } }
  return { to: view.contact.email, held: null }
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

/** The list's ids in the order shown (J / K walks them). */
export const navIdsOf = (list: InquiryList | null): string[] => (list ? list.rows.map((row) => row.id) : [])

/** The next inquiry after a decision (the queue moves on), else null. */
export function nextAfter(ids: readonly string[], current: string): string | null {
  const index = ids.indexOf(current)
  if (index < 0) return ids[0] ?? null
  return ids[index + 1] ?? ids[index - 1] ?? null
}
