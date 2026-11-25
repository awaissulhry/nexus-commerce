import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { DraftRecord, DraftRequest, PastLine, RequestSource, RequestStatus, Verdict } from './api'
import { holdsSend } from '@nexus/factory-domain/sales/portal-ordering/rules'
// B-TH-304: the customer's own order numbers.
import type { OwnNumber } from './api'
// od-w1.1: the ONE draft order's pure parts live in src/lib/order-draft (both doors draw them); the portal's own stay here.
import { customLinesOf, customTitleOf, entriesInOrder, writeHeld, type DraftEntry, type WriteFacts } from '../../../lib/order-draft/model'
export * from '../../../lib/order-draft/model'

/**
 * New order & reorder (B-W2b-194; design portal.customer.neworder, SCR-185), pure: the page's address, the three ways in,
 * the header's autosave (only what changed, checked by the API's limits), the delivery addresses it offers, a line's size
 * grid and what its save sends, every problem, notice and held reason in the page's words from codes and figures, the
 * summary, the reorder's choice and the sheet's verdicts. The container reads and writes; the views draw.
 */

export const NS = 'portal-ordering'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string


// ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const WAYS = ['pick', 'reorder', 'upload'] as const
export type Way = (typeof WAYS)[number]
export const isWay = (value: unknown): value is Way => typeof value === 'string' && (WAYS as readonly string[]).includes(value)

export const SOURCE_WAY: Readonly<Record<RequestSource, Way>> = { PICKER: 'pick', REORDER: 'reorder', UPLOAD: 'upload' }

export interface NewOrderQuery {
  draft?: string | null
  way?: Way | null
  /** Styles to add (the catalogue's "Add to order"), comma-separated ids. */
  styles?: readonly string[] | null
  /** A past order to reorder (the order record's "Reorder this line"), and the line. */
  reorder?: string | null
  line?: string | null
}

/** `/p/<party>/orders/new?draft=&way=&styles=&reorder=&line=`. */
export function newOrderHref(prefix: string, query: NewOrderQuery = {}): string {
  const search = new URLSearchParams()
  if (query.draft) search.set('draft', query.draft)
  if (query.way) search.set('way', query.way)
  if (query.styles && query.styles.length > 0) search.set('styles', query.styles.join(','))
  if (query.reorder) search.set('reorder', query.reorder)
  if (query.line) search.set('line', query.line)
  const text = search.toString()
  return `${prefix}/orders/new${text ? `?${text}` : ''}`
}

/** The ids of `styles=` (at most 20, each once). */
export const stylesOf = (value: string | null | undefined): string[] =>
  [...new Set((value ?? '').split(',').map((part) => part.trim()).filter((part) => /^[0-9a-f-]{8,64}$/i.test(part)))].slice(0, 20)

// ── B-TH-304 (pick A, plan §0.5): an order named by the customer's own number, never the office's series ──────────────────
/** RefPair's second side for a past order: the customer's own number ("Your order" · "12"); null when it has none. */
export function ownOrderRef(number: OwnNumber, locale: Locale): { label: string; value: string } | null {
  if (!number) return null
  const words = number.words[locale]
  const value = String(number.seq)
  return { label: words.endsWith(value) ? words.slice(0, words.length - value.length).trim() : words, value }
}

/** The label of a past order's lines: "Lines of your order 12", else by its day. */
export const orderLinesLabel = (order: { readonly yourNumber: OwnNumber; readonly orderDate: string | null }, t: Translate, day: (date: string) => string): string =>
  order.yourNumber ? t('reorder.linesOwn', { seq: order.yourNumber.seq }) : t('reorder.linesDay', { day: order.orderDate ? day(order.orderDate) : '—' })
// ── end B-TH-304

/** The orders list a sent request waits in (B-W2b-191: the Requested chip). */
export const requestedHref = (prefix: string): string => `${prefix}/orders?chip=REQUESTED`

// ── money, days ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A decimal price as the API writes it ("410.00", "12.345") with its currency: 2 to 4 decimals. */
export function priceText(value: string | null | undefined, currency: string, locale: Locale): string | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}



/** The sizes a past order's line asked that the copy leaves out. */
export const droppedOf = (line: Pick<PastLine, 'sizesOrdered' | 'sizes'>): string[] => line.sizesOrdered.map((row) => row.size).filter((size) => !line.sizes.some((row) => row.size === size))

/** Why the send cannot go (key + count), or null: an invalid value only (R1). Typed work is saved first by the send itself. */
export function sendHeld(request: Pick<DraftRequest, 'problems' | 'status'>, facts: WriteFacts): { key: string; count?: number } | null {
  const held = writeHeld(facts)
  if (held) return { key: held }
  if (request.status !== 'DRAFT') return { key: 'held.notDraft' }
  // od-w1.2 (R1): the domain's own rule (od-s `holdsSend`) — an INVALID value holds it (a date that passed, a stale price …), never
  // a missing one (no line, no sizes, no total, no people): a draft may go with nothing in it.
  const holding = request.problems.filter((problem) => holdsSend(problem.code)).length
  return holding > 0 ? { key: 'held.problems', count: holding } : null
}

/** How the draft is named in the start's "Continue your draft" row. */
export function draftRowWords(row: { updatedAt: string; lines: number; customerRef: string | null }, t: Translate, day: (iso: string) => string): string {
  const when = day(row.updatedAt)
  return row.customerRef ? t('start.draftRef', { day: when, count: row.lines, ref: row.customerRef }) : t('start.draft', { day: when, count: row.lines })
}

// ── reorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Why a past order's line cannot be chosen (a key), or null. A discontinued colour needs another one first. */
export function reorderLineHeld(line: Pick<PastLine, 'addable' | 'needsColour'>, colour: string | null | undefined): string | null {
  if (line.addable) return null
  if (line.needsColour) return colour ? null : 'reorder.held.colour'
  return 'reorder.held.notAddable'
}

/** What "Add N lines to the draft" sends: the chosen lines, a discontinued colour's choice with them. */
export function reorderBody(lines: readonly PastLine[], selected: readonly string[], colours: Readonly<Record<string, string>>): { orderLineId: string; colourwayId?: string }[] {
  return lines
    .filter((line) => selected.includes(line.orderLineId) && reorderLineHeld(line, colours[line.orderLineId]) === null)
    .map((line) => (line.needsColour ? { orderLineId: line.orderLineId, colourwayId: colours[line.orderLineId]! } : { orderLineId: line.orderLineId }))
}

/** The lines chosen at first: every one that can go as it is (or the one the order record asked for). */
export const reorderStart = (lines: readonly PastLine[], only: string | null): string[] =>
  lines.filter((line) => (only ? line.orderLineId === only : true) && line.addable).map((line) => line.orderLineId)

// ── the sheet ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const COLUMN_KEYS: Readonly<Record<string, string>> = { style: 'style', colour: 'colour', size: 'size', quantity: 'quantity', 'your code': 'yourCode' }

/**
 * A row's reason in the page's language. The domain writes a catalogue or size refusal in both languages; a cell the
 * imports engine could not read comes in its English alone ("Quantity: …"): that one is said in our words with its column.
 */
export function verdictReason(reason: { it: string; en: string }, locale: Locale, t: Translate): string {
  if (reason.it !== reason.en) return reason[locale]
  const column = /^([A-Za-z ]+):/.exec(reason.en)?.[1]?.trim().toLowerCase()
  const key = column ? COLUMN_KEYS[column] : undefined
  return key ? t('upload.cellProblem', { column: t(`upload.col.${key}`) }) : t('upload.rowProblem')
}

export const verdictTone = (verdict: Pick<Verdict, 'status'>): 'success' | 'danger' => (verdict.status === 'READY' ? 'success' : 'danger')

/** What happened to sizes a reorder or a sheet brought to a line the draft had: "Size 54 of JKT-02 kept your 5". */
export function mergeWords(answer: { added?: number; merged?: readonly { lineId: string; size: string }[]; kept?: readonly { lineId: string; size: string }[] }, record: DraftRecord, t: Translate): string[] {
  const out: string[] = []
  const style = (lineId: string) => record.request.lines.find((line) => line.id === lineId)?.style.code ?? ''
  if (answer.added !== undefined) out.push(t('done.added', { count: answer.added }))
  for (const row of answer.merged ?? []) out.push(t('done.merged', { size: row.size, style: style(row.lineId) }))
  for (const row of answer.kept ?? []) out.push(t('done.kept', { size: row.size, style: style(row.lineId) }))
  return out
}

/** The refusal of a write in our words (a key), by the API's kind. */
export function refusalOf(kind: string | null): string {
  switch (kind) {
    case 'conflict':
      return 'refusal.conflict'
    case 'invalid':
      return 'refusal.invalid'
    case 'forbidden':
      return 'refusal.forbidden'
    case 'not_found':
      return 'refusal.notFound'
    case 'rate_limited':
      return 'refusal.rateLimited'
    case 'unavailable':
      return 'refusal.unavailable'
    default:
      return 'refusal.other'
  }
}

/** What the reader may do beside filling the draft (B-CP-070); an older answer without `may`: as before (the Buyer's page). */
export const mayOf = (request: Pick<DraftRequest, 'may'>): { send: boolean; withdraw: boolean; discard: boolean } => request.may ?? { send: true, withdraw: false, discard: true }

/** The people who may send orders, for the held Send's words: ACTIVE buyers and admins (never the reader); else the admins. */
export function whoMayOrder(people: readonly { readonly id: string; readonly displayName: string; readonly status: string; readonly roleKey: string | null; readonly admin: boolean }[] | null, me: string, admins: readonly string[]): string[] {
  const named = (people ?? []).filter((person) => person.id !== me && person.status === 'ACTIVE' && (person.admin || person.roleKey === 'customer-buyer')).map((person) => person.displayName)
  return [...new Set(named.length > 0 ? named : admins)].sort((a, b) => a.localeCompare(b))
}

/**
 * Why "Send to the factory" cannot go now (key, count, names), or null — held, never hidden: a preview, offline, saving; not a
 * draft any more; a colleague who fills drafts but may not order (the names of who can); a line with no piece; problems.
 */
export function draftSendHeld(request: Pick<DraftRequest, 'problems' | 'status' | 'may'>, facts: WriteFacts, names: readonly string[]): { key: string; count?: number; names?: string } | null {
  const held = writeHeld(facts)
  if (held) return { key: held }
  if (request.status !== 'DRAFT') return { key: 'held.notDraft' }
  if (!mayOf(request).send) return names.length > 0 ? { key: 'draftPage.sendHeld', names: names.join(', ') } : { key: 'draftPage.sendHeldNone' }
  return sendHeld(request, facts)
}

/** Why Discard… cannot go (a key), or null: a preview or offline, or neither one who may order nor the one who started it. */
export function draftDiscardHeld(request: Pick<DraftRequest, 'may'>, facts: WriteFacts): string | null {
  return writeHeld(facts) ?? (mayOf(request).discard ? null : 'draftPage.discardHeld')
}

/** Reorder copies a past order: a colleague whose access shows no orders sees it held with why (D11). */
export const reorderHeldKey = (mayOrder: boolean): string | null => (mayOrder ? null : 'draftPage.reorderHeld')

/** The draft as one of the page's states (the view draws one banner and the right cards for each). */
export type DraftState = 'empty' | 'partly' | 'held' | 'sent' | 'refused' | 'withdrawn' | 'accepted'

export function draftStateOf(request: Pick<DraftRequest, 'status' | 'lines' | 'problems' | 'may'> & Partial<Pick<DraftRequest, 'customLines'>>): DraftState {
  if (request.status === 'SENT') return 'sent'
  if (request.status === 'REFUSED') return 'refused'
  if (request.status === 'WITHDRAWN') return 'withdrawn'
  if (request.status === 'ACCEPTED') return 'accepted'
  if (request.lines.length + customLinesOf(request).length === 0) return 'empty' // F-CP-154: lines of every kind
  return request.problems.length > 0 || !mayOf(request).send ? 'held' : 'partly'
}

/**
 * A draft no longer a draft, in words, with where it leads: the order for one whose access shows orders; a colleague who does
 * not see orders reads who follows it instead (never a door that leads nowhere). Refused: "Start a new draft".
 */
export function closedOf(status: RequestStatus, seesOrders: boolean): { body: string; open: 'order' | 'orders' | null; startNew: boolean } {
  if (status === 'ACCEPTED') return seesOrders ? { body: 'closed.ACCEPTED', open: 'order', startNew: false } : { body: 'draftPage.acceptedNoOrders', open: null, startNew: false }
  if (status === 'REFUSED') return { body: seesOrders ? 'closed.REFUSED' : 'draftPage.refusedNoOrders', open: seesOrders ? 'orders' : null, startNew: true }
  if (status === 'SENT') return { body: seesOrders ? 'closed.SENT' : 'draftPage.sentNoOrders', open: seesOrders ? 'orders' : null, startNew: false }
  return { body: `closed.${status}`, open: null, startNew: true }
}

// ── "Your price" ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The API's shape of the customer's own price: at least 0, at most 6 decimals (B-CP-076). */
export const OWN_PRICE = /^\d{1,12}(\.\d{1,6})?$/

/**
 * The customer's own price as typed ("18,50", "18.50", "€ 1.250,00") → the decimal the API takes ("18.50"), null for an empty cell
 * (it clears the price), or a problem key.
 */
export function ownPriceOf(typed: string): { value: string | null } | { problem: string } {
  let text = typed.replace(/[\s €]/g, '')
  if (text === '') return { value: null }
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  else if (comma >= 0) text = text.replace(',', '.')
  return OWN_PRICE.test(text) ? { value: text } : { problem: 'draftPage.price.problem' }
}

/** Two of the customer's prices the same as decimals ("18.5" = "18.50"); null = none. */
export const sameOwnPrice = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = a ?? null
  const right = b ?? null
  return left === null || right === null ? left === right : Number(left) === Number(right)
}

/**
 * What leaving a "Your price" cell writes: nothing for a reader without the price grain (the page never sends the key then: the grain
 * filter would refuse the whole body, M-CP-2), nothing when the cell still holds the line's price, a problem when it does not read as a
 * price; else the line's kind (which route) and the decimal (null clears it).
 */
export function ownPriceWriteOf(record: Pick<DraftRecord, 'request' | 'seesPrices'>, lineId: string, typed: string): { problem: string } | { lineKind: 'CATALOGUE' | 'CUSTOM'; value: string | null } | null {
  if (!record.seesPrices) return null
  const read = ownPriceOf(typed)
  if ('problem' in read) return read
  const catalogue = record.request.lines.find((entry) => entry.id === lineId)
  const custom = customLinesOf(record.request).find((entry) => entry.id === lineId)
  const line = catalogue ?? custom
  if (!line || sameOwnPrice(line.brandUnitPrice, read.value)) return null
  return { lineKind: catalogue ? 'CATALOGUE' : 'CUSTOM', value: read.value }
}

/**
 * What the reader does with "Your price": a price holder types it while the draft may be written (a preview, offline, a draft no
 * longer one: read only); anyone else reads "Prices are not part of your access." — no field, no figure (M-CP-2).
 */
export const yourPriceAccess = (seesPrices: boolean, writeHeld: string | null): 'edit' | 'read' | 'none' => (!seesPrices ? 'none' : writeHeld === null ? 'edit' : 'read')

export interface PriceRow {
  id: string
  kind: DraftEntry['kind']
  seq: number
  label: string
  pieces: number
  /** Our list price on a catalogue line (the price shown); a custom line has none. */
  ours: string | null
  /** The customer's own price as the draft holds it. */
  yours: string | null
}

/** Part 6's rows: every line by seq with its pieces, our list price beside it on catalogue lines, and the customer's own price. */
export function priceRowsOf(request: Pick<DraftRequest, 'lines'> & Partial<Pick<DraftRequest, 'customLines'>>, t: Translate, locale?: Locale): PriceRow[] {
  return entriesInOrder(request).map((entry) =>
    entry.kind === 'CATALOGUE'
      ? { id: entry.line.id, kind: entry.kind, seq: entry.line.seq, label: entry.line.style.name.trim() || entry.line.style.code, /* od-fx10 W-17: the table's one name for it */ pieces: entry.line.pieces, ours: entry.line.unitPriceShown ?? null, yours: entry.line.brandUnitPrice ?? null }
      : { id: entry.line.id, kind: entry.kind, seq: entry.line.seq, label: customTitleOf(entry.line, t, locale), pieces: entry.line.pieces, ours: null, yours: entry.line.brandUnitPrice ?? null },
  )
}

/**
 * "Your total": each line's own price × its pieces (to the cent) when every line has one — a price typed and not saved yet counts as
 * typed (`typed`, by line id; a cell that does not read as a price counts as none) —; else null, and how many lines lack it.
 */
export function ownTotalOf(rows: readonly Pick<PriceRow, 'id' | 'pieces' | 'yours'>[], typed: Readonly<Record<string, string>> = {}): { total: string | null; missing: number } {
  let cents = 0
  let missing = 0
  for (const row of rows) {
    const read = typed[row.id] !== undefined ? ownPriceOf(typed[row.id]!) : null
    const value = read === null ? row.yours : 'value' in read ? read.value : null
    if (value === null) {
      missing += 1
      continue
    }
    cents += Math.round(Number(value) * row.pieces * 100)
  }
  return { total: missing === 0 && rows.length > 0 ? (cents / 100).toFixed(2) : null, missing }
}
// ---- end F-CP-154
