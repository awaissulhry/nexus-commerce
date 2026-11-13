import type { ReviewState } from '@nexus/ui/patterns'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { QuoteDetail, QuoteLine } from '../../api'
import type { BulkProblem, DeliveryInput, LineSchedule, QuoteTerms, QuoteWarning, WarningSeverity } from './api'

/**
 * The quote record's W2b rules (B-W2b-316), pure: the Warnings section in this screen's words (codes, never the API's
 * sentences), the Table view's rows, the line drawer's delivery schedule (draft, problems, what goes at the promise date),
 * and the words of the bulk reviews (paste, fill by curve, bulk sizes). No fetching, no React: the tests hold them.
 */

/** The catalogue of every W2b quote part (messages/<locale>/sales-quotes-depth.json). */
export const DEPTH_NS = 'sales-quotes-depth'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A message key with its params, in the depth catalogue unless `ns` says `sales` (W1's words, reused). */
export interface Words {
  key: string
  params?: Record<string, string | number>
  ns?: 'sales'
}

export const LINE_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE', 'FEE'] as const

// ---- Warnings (design quote.lines.warnings) ---------------------------------------------------------------------------

/**
 * The codes W1's send dialog already says (`sales` catalogue `check.<CODE>`, B-W2b-294 added the five line rules): the
 * Warnings section says the same words. ACCOUNT_OVERDUE is said here only (the depth catalogue); any other code a later
 * rule adds says the generic words until it gets its own.
 */
export const SALES_CHECK_CODES = [
  'PARTY_NOT_QUOTABLE', 'NO_LINES', 'NOT_PRICED', 'COST_INCOMPLETE', 'NO_COST_REVISION', 'COST_ESTIMATE', 'CERTIFICATE', 'VIES_NOT_PROVEN',
  'APPROVAL_NEEDED', 'NO_VALIDITY', 'VALIDITY_PAST', 'NO_BILL_TO', 'NO_SHIP_TO', 'NO_CONTACT_EMAIL', 'NO_PROMISE_DATE', 'ACCOUNT_ON_HOLD',
  'COMPANY_LEGAL', 'BILL_TO_INCOMPLETE', 'SHIP_TO_INCOMPLETE', 'SDI_IDENTITY', 'VAT_CHANGED', 'FIRM_OFFER_STANDS', 'TERMS_VERSION',
  'NO_BANK_DETAILS', 'PROOF_NOT_READY', 'BELOW_MINIMUM', 'PRIVATE_LABEL', 'OUTSIDE_RELEASED_SCOPE', 'STYLE_PHASE_OUT', 'NOT_SOLD_IN_MARKET',
  'BLOCKED_MATERIAL',
] as const
export const DEPTH_WARNING_CODES = ['ACCOUNT_OVERDUE'] as const

export const SEVERITY_TONE: Record<WarningSeverity, Tone> = { BLOCKS: 'danger', WARNING: 'warning', INFO: 'info' }

const detailOf = (warning: Pick<QuoteWarning, 'details'>, key: string): unknown => (warning.details ?? {})[key]

/** A warning in this screen's words: W1's `check.<CODE>` when it knows the code, the depth catalogue's otherwise. */
export function warningWords(warning: Pick<QuoteWarning, 'code' | 'details'>): Words {
  const size = detailOf(warning, 'size')
  if ((SALES_CHECK_CODES as readonly string[]).includes(warning.code)) return { ns: 'sales', key: `check.${warning.code}`, params: { size: typeof size === 'string' ? size : '' } }
  if ((DEPTH_WARNING_CODES as readonly string[]).includes(warning.code)) return { key: `warn.code.${warning.code}` }
  return { key: 'warn.code.other' }
}

/** The overdue account's facts (price grain: the amounts are absent without it). */
export function overdueOf(warning: Pick<QuoteWarning, 'code' | 'details'>): { amounts: Array<{ currency: string; amount: number }>; daysLate: number | null; invoices: number | null } | null {
  if (warning.code !== 'ACCOUNT_OVERDUE') return null
  const raw = detailOf(warning, 'overdue')
  const amounts = Array.isArray(raw)
    ? raw.flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as { amount?: unknown }).amount === 'number' && typeof (entry as { currency?: unknown }).currency === 'string' ? [{ currency: (entry as { currency: string }).currency, amount: (entry as { amount: number }).amount }] : []))
    : []
  const daysLate = detailOf(warning, 'daysLate')
  const invoices = detailOf(warning, 'invoices')
  return { amounts, daysLate: typeof daysLate === 'number' ? daysLate : null, invoices: typeof invoices === 'number' ? invoices : Array.isArray(invoices) ? invoices.length : null }
}

/** Where Fix / Open goes: the record that settles it (its own page when built), else the quote's line in the drawer. */
export function warningTarget(warning: Pick<QuoteWarning, 'open' | 'lineIds'>, prefix: string, lineHref: (lineId: string) => string): { href: string; kind: 'open' | 'fix' } | null {
  if (warning.open) {
    const address = recordAddress({ type: warning.open.recordType, id: warning.open.recordId }, OFFICE_PAGES)
    const tab = warning.open.tab && !address.includes('?') && !address.startsWith('/records/') ? `?tab=${encodeURIComponent(warning.open.tab)}` : ''
    return { href: `${prefix}${address}${tab}`, kind: 'open' }
  }
  const lineId = warning.lineIds[0]
  return lineId ? { href: lineHref(lineId), kind: 'fix' } : null
}

// ---- sizes in words ---------------------------------------------------------------------------------------------------

/** "50 2 · 52 6 · 54 2" in the style's order (sizes it does not know go last, as they come). */
export function sizesText(sizes: Readonly<Record<string, number>>, order: readonly string[] = []): string {
  const rank = (size: string) => (order.indexOf(size) < 0 ? order.length + 1 : order.indexOf(size))
  return Object.entries(sizes)
    .filter(([, pieces]) => pieces > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([size, pieces]) => `${size} ${pieces}`)
    .join(' · ')
}

export const sizesOfLine = (line: Pick<QuoteLine, 'sizes'>): Record<string, number> => Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))

// ---- the Table view (design quote.lines.table) ------------------------------------------------------------------------

export interface TableRow {
  id: string
  seq: number
  kind: string
  style: string
  styleName: string
  colourway: string
  colourName: string
  sizes: string
  quantity: number
  /** Money only by grain: absent without it (never 0). */
  unitPrice?: string
  discountPct: string | null
  netAmount?: number
  vat: { rate: string; nature: string | null }
  unitCost?: string | null
  costComplete: boolean
  marginPct?: string | null
  belowFloor?: boolean
  /** The line's delivery schedule: its first date and how many deliveries; null: everything at the promise date. */
  delivery: { first: string; count: number } | null
  /** Warnings that name this line. */
  warnings: number
}

export function tableRows(quote: Pick<QuoteDetail, 'lines'>, terms: Pick<QuoteTerms, 'lines'> | null, warnings: readonly Pick<QuoteWarning, 'lineIds'>[] | null): TableRow[] {
  const schedules = new Map((terms?.lines ?? []).map((entry) => [entry.lineId, entry]))
  return [...quote.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => {
      const schedule = schedules.get(line.id)
      const dates = (schedule?.deliveries ?? []).map((delivery) => delivery.deliveryDate).sort()
      return {
        id: line.id,
        seq: line.seq,
        kind: line.kind,
        style: line.style.code,
        styleName: line.style.name,
        colourway: line.colourway.code,
        colourName: line.colourway.name,
        sizes: sizesText(sizesOfLine(line)),
        quantity: line.quantity,
        ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
        discountPct: line.discountPct,
        ...(line.netAmount !== undefined ? { netAmount: line.netAmount } : {}),
        vat: { rate: line.vatRatePct, nature: line.vatNature },
        ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
        costComplete: line.costComplete,
        ...(line.marginPct !== undefined ? { marginPct: line.marginPct } : {}),
        ...(line.belowFloor !== undefined ? { belowFloor: line.belowFloor } : {}),
        delivery: dates.length > 0 ? { first: dates[0]!, count: dates.length } : null,
        warnings: (warnings ?? []).filter((warning) => warning.lineIds.includes(line.id)).length,
      }
    })
}

/** The lines a size or price action reaches: size-grid lines only (a fee or a made-to-measure unit has no size run). */
export const sizeGridIds = (quote: Pick<QuoteDetail, 'lines'>, ids: readonly string[]): string[] => quote.lines.filter((line) => ids.includes(line.id) && line.kind === 'SIZE_GRID').map((line) => line.id)

/** The line before / after this one (⌘↑ / ⌘↓ in the drawer), in line order; null at the ends. */
export function neighbourLine(quote: Pick<QuoteDetail, 'lines'>, lineId: string, step: -1 | 1): string | null {
  const ordered = [...quote.lines].sort((a, b) => a.seq - b.seq)
  const index = ordered.findIndex((line) => line.id === lineId)
  if (index < 0) return null
  return ordered[index + step]?.id ?? null
}

// ---- the line drawer's delivery schedule (design pop:quotes.lineDrawer "Delivery schedule (W2b)") --------------------

export interface DeliveryRow {
  key: string
  /** YYYY-MM-DD, '' while not chosen. */
  date: string
  /** Pieces per size as typed (a size grid line); empty for a made-to-measure unit. */
  sizes: Record<string, string>
  note: string
}

export const MAX_DELIVERIES = 24
export const DELIVERY_NOTE_MAX = 500

let rowSeq = 0
export const newRowKey = (): string => `d${++rowSeq}`

/** The line's schedule as the drawer edits it. */
export function deliveryRowsOf(schedule: Pick<LineSchedule, 'deliveries'> | null): DeliveryRow[] {
  return (schedule?.deliveries ?? []).map((delivery) => ({
    key: delivery.id,
    date: delivery.deliveryDate,
    sizes: Object.fromEntries(Object.entries(delivery.sizes ?? {}).map(([size, pieces]) => [size, String(pieces)])),
    note: delivery.note ?? '',
  }))
}

const piecesOf = (text: string | undefined): number | null => {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return 0
  return /^\d{1,6}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

/** The schedule as PUT …/deliveries takes it (sizes with pieces only; a made-to-measure unit carries none). */
export function deliveriesBody(rows: readonly DeliveryRow[], line: Pick<QuoteLine, 'kind'>): DeliveryInput[] {
  return rows.map((row) => ({
    deliveryDate: row.date,
    ...(line.kind === 'SIZE_GRID' ? { sizes: Object.fromEntries(Object.entries(row.sizes).flatMap(([size, text]) => { const pieces = piecesOf(text); return pieces && pieces > 0 ? [[size, pieces]] : [] })) } : {}),
    note: row.note.trim() === '' ? null : row.note.trim(),
  }))
}

/** What goes at the promise date per size: the line's pieces less the scheduled ones (never below 0). */
export function remainderOf(rows: readonly DeliveryRow[], line: Pick<QuoteLine, 'sizes'>): Record<string, number> {
  const left: Record<string, number> = {}
  for (const row of line.sizes) {
    const scheduled = rows.reduce((sum, delivery) => sum + (piecesOf(delivery.sizes[row.size]) ?? 0), 0)
    if (row.quantity - scheduled > 0) left[row.size] = row.quantity - scheduled
  }
  return left
}

/** What stops the schedule from being saved, in words (the API says the same rules first: planSchedule). */
export function scheduleProblems(rows: readonly DeliveryRow[], line: Pick<QuoteLine, 'kind' | 'sizes'>, today: string): Words[] {
  const problems: Words[] = []
  if (line.kind === 'FEE') return rows.length > 0 ? [{ key: 'drawer.problem.fee' }] : []
  if (rows.length > MAX_DELIVERIES) problems.push({ key: 'drawer.problem.many', params: { max: MAX_DELIVERIES } })
  if (line.kind === 'MADE_TO_MEASURE' && rows.length > 1) problems.push({ key: 'drawer.problem.oneUnit' })
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const n = index + 1
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problems.push({ key: 'drawer.problem.noDate', params: { n } })
    else if (row.date < today) problems.push({ key: 'drawer.problem.past', params: { n } })
    else if (seen.has(row.date)) problems.push({ key: 'drawer.problem.twice', params: { n } })
    seen.add(row.date)
    if (row.note.trim().length > DELIVERY_NOTE_MAX) problems.push({ key: 'drawer.problem.note', params: { n, max: DELIVERY_NOTE_MAX } })
    if (line.kind === 'SIZE_GRID') {
      const bad = Object.entries(row.sizes).filter(([, text]) => piecesOf(text) === null)
      if (bad.length > 0) problems.push({ key: 'drawer.problem.pieces', params: { n, size: bad[0]![0] } })
      const total = Object.values(row.sizes).reduce((sum, text) => sum + (piecesOf(text) ?? 0), 0)
      if (bad.length === 0 && total === 0) problems.push({ key: 'drawer.problem.empty', params: { n } })
    }
  })
  if (line.kind === 'SIZE_GRID') {
    for (const size of line.sizes) {
      const scheduled = rows.reduce((sum, row) => sum + (piecesOf(row.sizes[size.size]) ?? 0), 0)
      if (scheduled > size.quantity) problems.push({ key: 'drawer.problem.over', params: { size: size.size, pieces: size.quantity } })
    }
    const unknown = rows.flatMap((row) => Object.keys(row.sizes).filter((size) => (piecesOf(row.sizes[size]) ?? 0) > 0 && !line.sizes.some((entry) => entry.size === size)))
    if (unknown.length > 0) problems.push({ key: 'drawer.problem.size', params: { size: unknown[0]! } })
  }
  return problems
}

/** The typed schedule differs from the saved one. */
export function scheduleChanged(rows: readonly DeliveryRow[], schedule: Pick<LineSchedule, 'deliveries'> | null, line: Pick<QuoteLine, 'kind'>): boolean {
  const key = (body: readonly DeliveryInput[]) => JSON.stringify([...body].map((entry) => ({ ...entry, sizes: entry.sizes ? Object.fromEntries(Object.entries(entry.sizes).sort(([a], [b]) => a.localeCompare(b))) : entry.sizes })).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate)))
  return key(deliveriesBody(rows, line)) !== key(deliveriesBody(deliveryRowsOf(schedule), line))
}

/** The schedule in words for the Terms tab: "2 Dec 6 · 15 Jan 4" is formatted by the view; here the deliveries in date order. */
export const deliveriesInOrder = (schedule: Pick<LineSchedule, 'deliveries'>): LineSchedule['deliveries'] => [...schedule.deliveries].sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))

// ---- the bulk reviews (paste, fill by curve, bulk sizes) ---------------------------------------------------------------

/** A bulk route's problem in this screen's words, by its code (the API's message is English). */
export function bulkProblemWords(problem: Pick<BulkProblem, 'code'>, label: string): Words {
  return { key: `bulk.problem.${problem.code}`, params: { line: label } }
}

/** A line's label for the reviews: "10 · SEED-JKT-01 BLK" from the quote (never the API's label words). */
export function lineLabel(quote: Pick<QuoteDetail, 'lines'>, lineId: string): string {
  const line = quote.lines.find((entry) => entry.id === lineId)
  return line ? `${line.seq} · ${line.style.code} ${line.colourway.code}` : '—'
}

/** Pieces per size before → after, only the sizes that move: "52 6 → 8 · 54 0 → 2". */
export function movesText(moves: ReadonlyArray<{ size: string; from: number; to: number }>): string {
  return moves.map((move) => `${move.size} ${move.from} → ${move.to}`).join(' · ')
}

// ---- the reviews' state, in words the view translates -------------------------------------------------------------------

/** A review's state as the container holds it: the DS ReviewState with this screen's Words in place of English. */
export type DepthReviewState =
  | { phase: 'reading' }
  | { phase: 'failed'; problem: Words }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'done'; results: Readonly<Record<string, { ok: boolean; words: Words }>> }

/** The DS ReviewState of a DepthReviewState, in the page's words. */
export function reviewStateOf(state: DepthReviewState, say: (words: Words) => string): ReviewState {
  switch (state.phase) {
    case 'failed':
      return { phase: 'failed', error: say(state.problem) }
    case 'done':
      return { phase: 'done', results: Object.fromEntries(Object.entries(state.results).map(([id, result]) => [id, { ok: result.ok, words: say(result.words) }])) }
    default:
      return state
  }
}
