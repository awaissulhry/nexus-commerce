import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { addressLine } from '../account/model'
import { LIMITS, type DraftLine, type DraftRecord, type DraftRequest, type HeaderBody, type NoticeCode, type PastLine, type Problem, type RequestSource, type ShipTo, type SizeAsk, type Verdict } from './api'

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

export const WAY_SOURCE: Readonly<Record<Way, RequestSource>> = { pick: 'PICKER', reorder: 'REORDER', upload: 'UPLOAD' }
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

export const pieces = (n: number, locale: Locale): string => formatNumber(n, locale, { maximumFractionDigits: 0 })

/** Today in the site's zone (YYYY-MM-DD). */
export const todayIn = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

// ── the header ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HeaderDraft {
  customerRef: string
  shipToAddressId: string
  requestedDate: string
  note: string
}
export type HeaderField = keyof HeaderDraft

export const headerDraftOf = (request: Pick<DraftRequest, 'customerRef' | 'shipToAddressId' | 'requestedDate' | 'note'> | null): HeaderDraft => ({
  customerRef: request?.customerRef ?? '',
  shipToAddressId: request?.shipToAddressId ?? '',
  requestedDate: request?.requestedDate ?? '',
  note: request?.note ?? '',
})

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The fields typed differently from what the draft holds (what the autosave sends; blank = null). */
export function headerChanges(saved: HeaderDraft, draft: HeaderDraft, only?: HeaderField): HeaderBody {
  const out: HeaderBody = {}
  const fields: HeaderField[] = only ? [only] : ['customerRef', 'shipToAddressId', 'requestedDate', 'note']
  for (const field of fields) {
    if ((blank(saved[field]) ?? '') === (blank(draft[field]) ?? '')) continue
    out[field] = blank(draft[field])
  }
  return out
}

export const headerDirty = (saved: HeaderDraft, draft: HeaderDraft): boolean => Object.keys(headerChanges(saved, draft)).length > 0

/** A field's problem (a key) by the API's limits, or null. */
export function headerProblem(field: HeaderField, draft: HeaderDraft, today: string): string | null {
  if (field === 'customerRef' && draft.customerRef.trim().length > LIMITS.customerRef) return 'head.problem.refLong'
  if (field === 'note' && draft.note.trim().length > LIMITS.note) return 'head.problem.noteLong'
  if (field === 'requestedDate' && draft.requestedDate !== '' && draft.requestedDate < today) return 'head.problem.datePast'
  return null
}

// ── delivery addresses ──────────────────────────────────────────────────────────────────────────────────────────────────
export type ShipToState = 'OK' | 'WAITING' | 'ARCHIVED'
export interface ShipToOption {
  id: string
  name: string | null
  line: string
  isDefault: boolean
  state: ShipToState
}

/**
 * The delivery addresses the order offers: every active one of ours or one we checked (the default first). A waiting one
 * (a customer's, not checked yet) only when it is the draft's own — the one just added here (design "waits for our
 * approval — you can still send"; F13b: accepting the request approves it). The draft's own archived one stays shown so
 * its problem reads.
 */
export function shipToOptions(addresses: readonly ShipTo[], chosen: string | null): ShipToOption[] {
  const out: ShipToOption[] = []
  for (const row of addresses) {
    const refused = row.approval?.status === 'REFUSED'
    const waiting = row.approval?.status === 'WAITING'
    const state: ShipToState = row.status !== 'ACTIVE' || refused ? 'ARCHIVED' : waiting ? 'WAITING' : 'OK'
    if (state !== 'OK' && row.id !== chosen) continue
    out.push({ id: row.id, name: row.name, line: addressLine(row), isDefault: row.isDefault && state === 'OK', state })
  }
  return out.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : 0))
}

// ── a line's size grid ──────────────────────────────────────────────────────────────────────────────────────────────────
export type Cells = Readonly<Record<string, number>>

/** The quantities a line holds, by size. */
export const cellsOf = (line: Pick<DraftLine, 'sizes'>): Record<string, number> => Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))

/** The grid's columns: the sizes offered today, then any size the line asks that is no longer offered. */
export const columnsOf = (line: Pick<DraftLine, 'sizes' | 'offered'>): string[] => [...line.offered, ...line.sizes.map((row) => row.size).filter((size) => !line.offered.includes(size))]

/** What a line's save sends: every size with pieces, in the grid's order. */
export function sizesBody(columns: readonly string[], cells: Cells): SizeAsk[] {
  const order = [...columns, ...Object.keys(cells).filter((size) => !columns.includes(size))]
  return order.flatMap((size) => {
    const quantity = Math.trunc(cells[size] ?? 0)
    return quantity > 0 ? [{ size, quantity: Math.min(quantity, LIMITS.quantity) }] : []
  })
}

export const piecesOfCells = (cells: Cells): number => Object.values(cells).reduce((sum, value) => sum + (value > 0 ? Math.trunc(value) : 0), 0)

/** The typed grid differs from what the line holds. */
export function lineChanged(line: Pick<DraftLine, 'sizes' | 'offered'>, cells: Cells): boolean {
  const saved = sizesBody(columnsOf(line), cellsOf(line))
  const typed = sizesBody(columnsOf(line), cells)
  return saved.length !== typed.length || saved.some((row, index) => row.size !== typed[index]!.size || row.quantity !== typed[index]!.quantity)
}

/** Why a typed line cannot be saved (a key), or null. */
export const lineHeld = (cells: Cells): string | null => (piecesOfCells(cells) === 0 ? 'lines.held.empty' : null)

// ── words from codes ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WordsKit {
  t: Translate
  price: (value: string | null | undefined) => string | null
}

/** A problem that holds the send, in the page's words. */
export function problemWords(problem: Problem, lines: readonly DraftLine[], kit: WordsKit): string {
  const { t } = kit
  const line = problem.lineId ? lines.find((entry) => entry.id === problem.lineId) : undefined
  const style = line?.style.code ?? t('problem.thisStyle')
  switch (problem.code) {
    case 'NO_LINES':
      return t('problem.NO_LINES')
    case 'TOO_MANY_LINES':
      return t('problem.TOO_MANY_LINES', { max: LIMITS.lines })
    case 'DATE_PAST':
      return t('problem.DATE_PAST')
    case 'SHIP_TO_ARCHIVED':
      return t('problem.SHIP_TO_ARCHIVED')
    case 'STYLE_NOT_SOLD':
      return t('problem.STYLE_NOT_SOLD', { style })
    case 'COLOUR_DISCONTINUED':
      return t('problem.COLOUR_DISCONTINUED', { colour: line?.colourway.name ?? '' })
    case 'SIZE_NOT_OFFERED':
      return t('problem.SIZE_NOT_OFFERED', { size: problem.size ?? '', style })
    case 'NO_SIZES':
      return t('problem.NO_SIZES')
    case 'PRICE_CHANGED': {
      const now = kit.price(line?.priceNow)
      const was = kit.price(line?.unitPriceShown)
      return now && was ? t('problem.PRICE_CHANGED', { now, was }) : now ? t('problem.PRICE_NEW', { now }) : t('problem.PRICE_ANY')
    }
  }
}

/** Where "Show me" goes for a problem: the line's card, or the order details. */
export const problemPlace = (problem: Problem): string => (problem.lineId ? `line-${problem.lineId}` : problem.code === 'NO_LINES' || problem.code === 'TOO_MANY_LINES' ? 'lines' : 'order-head')

export interface NoticeFacts {
  style?: string | null
  colour?: string | null
  priceNow?: string | null
  priceThen?: string | null
  /** Sizes left out (a past order's line: ordered then, not offered now). */
  dropped?: readonly string[] | null
}

/** A reorder's difference in the page's words. */
export function noticeWords(code: NoticeCode, facts: NoticeFacts, kit: WordsKit): string {
  const { t } = kit
  switch (code) {
    case 'PRICE_CHANGED': {
      const now = kit.price(facts.priceNow)
      const was = kit.price(facts.priceThen)
      return now && was ? t('notice.PRICE_CHANGED', { now, was }) : t('notice.PRICE_ANY')
    }
    case 'REVISION_CHANGED':
      return t('notice.REVISION_CHANGED')
    case 'SIZES_DROPPED':
      return facts.dropped && facts.dropped.length > 0 ? t('notice.SIZES_DROPPED', { sizes: facts.dropped.join(', ') }) : t('notice.SIZES_DROPPED_SOME')
    case 'COLOUR_DISCONTINUED':
      return t('notice.COLOUR_DISCONTINUED', { colour: facts.colour ?? '' })
    case 'STYLE_NOT_SOLD':
      return t('notice.STYLE_NOT_SOLD', { style: facts.style ?? '' })
    case 'MADE_TO_MEASURE':
      return t('notice.MADE_TO_MEASURE')
    case 'NO_SIZES_LEFT':
      return t('notice.NO_SIZES_LEFT')
  }
}

export const noticeTone = (code: NoticeCode): 'info' | 'warning' | 'danger' => (code === 'PRICE_CHANGED' || code === 'REVISION_CHANGED' ? 'info' : code === 'STYLE_NOT_SOLD' || code === 'MADE_TO_MEASURE' || code === 'NO_SIZES_LEFT' ? 'danger' : 'warning')

/** The sizes a past order's line asked that the copy leaves out. */
export const droppedOf = (line: Pick<PastLine, 'sizesOrdered' | 'sizes'>): string[] => line.sizesOrdered.map((row) => row.size).filter((size) => !line.sizes.some((row) => row.size === size))

// ── the send ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WriteFacts {
  /** An office person previewing the portal: nothing is written. */
  preview: boolean
  offline: boolean
  busy: boolean
}

/** Why nothing can be written now (a key), or null. */
export function writeHeld(facts: WriteFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  return null
}

/** Why the send cannot go (key + count), or null. Typed work is saved first by the send itself. */
export function sendHeld(request: Pick<DraftRequest, 'problems' | 'status'>, facts: WriteFacts & { emptyLine: boolean }): { key: string; count?: number } | null {
  const held = writeHeld(facts)
  if (held) return { key: held }
  if (request.status !== 'DRAFT') return { key: 'held.notDraft' }
  if (facts.emptyLine) return { key: 'lines.held.empty' }
  if (request.problems.length > 0) return { key: 'held.problems', count: request.problems.length }
  return null
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
