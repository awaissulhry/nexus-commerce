import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { AmendLineInput } from '../amendments/amendments'
import { LINE_CHANGE_STATUSES, type SalesOrderStatus } from '../orders/orders'
import { addDays, MAX_SIZE_QUANTITY, type SalesLineKind } from '../quotes/quotes'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077 "change request from the portal", SAL-078 "cancel request
 * with cut-off rules"; design portal.customer.orders "Ask for a change" — sizes, date, ship-to, note, "rules shown before the
 * click: cells of lines already cut are held with the reason 'Leather was cut on 12 Oct'" — and "Ask to cancel" — "per
 * line, what the cut-off rules say now", a reason, "no right of withdrawal applies" for a consumer's made-to-measure
 * garment), pure. The API reads the facts (the order and its lines in the customer's own scope; the cut-off settings, the
 * cuts and the reason list in the tenant's) and these rules say what may be asked, in words, before and at the click.
 *
 *   asked       only of an order CONFIRMED, IN_PRODUCTION or READY (the database says so too), one OPEN request per order
 *   cut-offs    SalesSettings (the company's row, else the tenant's): from which status on a cancel is no longer asked
 *               and within how many days of the promise date (the promise at most that many days away, or past); from
 *               which status on a change is no longer asked. A status cut-off at CONFIRMED means "never from the portal"
 *   cut lines   a line whose cutting started (a cut of leather logged for one of its work-order cells, or a bundle made
 *               of it) is held: none of its sizes change and it is not cancelled; a whole-order cancel is refused once
 *               any line is cut ("a cancel after cutting started is refused")
 *   amendment   a change is applied by W2a's amendment (prices again; a moved net total asks the customer to accept the
 *               order again): an order with a made-to-measure unit or a line closed short takes none, so those are not
 *               asked here; a change never takes every piece of a line (that is a cancel of the line); a partial cancel
 *               closes its lines short (W2a's close: nothing more is made or shipped of them) — never a removal, so the
 *               request keeps naming them (OrderChangeRequestLine's reference)
 *   SAL-304     the consumer's no-withdrawal rule stays: a made-to-measure order for a consumer may still be ASKED to be
 *               cancelled (the factory decides), and the pop-up says no right of withdrawal applies
 * The cancel fee per line (the design's "Fee 15%"): ./fee.ts (B-W2b-F14, SalesSettings.cancelFeePct; shown, never charged).
 */

export interface Words {
  readonly it: string
  readonly en: string
}

export const REQUEST_KINDS = ['CHANGE', 'CANCEL'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

export const REQUEST_STATUSES = ['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const KIND_WORDS: Readonly<Record<RequestKind, Words>> = Object.freeze({
  CHANGE: { it: 'Richiesta di modifica', en: 'Change request' },
  CANCEL: { it: 'Richiesta di annullamento', en: 'Cancel request' },
})

/** The request's state in the customer's words (the office never shows who decided). */
export const REQUEST_STATUS_WORDS: Readonly<Record<RequestStatus, Words>> = Object.freeze({
  OPEN: { it: 'In attesa della nostra risposta', en: 'Waiting for our answer' },
  ACCEPTED: { it: 'Accettata', en: 'Accepted' },
  REFUSED: { it: 'Non accettata', en: 'Not accepted' },
  WITHDRAWN: { it: 'Ritirata', en: 'Withdrawn' },
})

/** SAL-304: what the cancel pop-up says of a made-to-measure order for a consumer (Codice del Consumo art. 59). */
export const NO_WITHDRAWAL_WORDS: Words = Object.freeze({
  it: 'Prodotto su misura per un consumatore: non si applica il diritto di recesso (Codice del Consumo art. 59). Puoi comunque chiederci di annullarlo.',
  en: 'Made to measure for a consumer: no right of withdrawal applies (Codice del Consumo art. 59). You can still ask us to cancel it.',
})

/** Their words, the office's answer: at most this many characters (the database holds the same). */
export const MAX_NOTE = 2000
export const MAX_ANSWER = 2000

/** The order statuses a request is asked in (W2a's amendment and cancel statuses). */
export const ASKABLE_STATUSES: readonly SalesOrderStatus[] = LINE_CHANGE_STATUSES

// ---- the cut-off settings ---------------------------------------------------------------------------------------------

/** A status cut-off: from this status on (in this order) the request is no longer asked from the portal. */
export const CUTOFF_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY'] as const
export type CutoffStatus = (typeof CUTOFF_STATUSES)[number]
export const MAX_CUTOFF_DAYS = 365

export interface Cutoffs {
  readonly cancelStatus: CutoffStatus | null
  /** Within this many days of the promise date a cancel is no longer asked; null: no such rule. */
  readonly cancelDays: number | null
  readonly changeStatus: CutoffStatus | null
}

export const NO_CUTOFFS: Cutoffs = Object.freeze({ cancelStatus: null, cancelDays: null, changeStatus: null })

const isCutoffStatus = (value: unknown): value is CutoffStatus => typeof value === 'string' && (CUTOFF_STATUSES as readonly string[]).includes(value)

/** The cut-offs as SalesSettings stores them (any other status is no rule: the database allows only these). */
export function cutoffsOf(row: { readonly cancelCutoffStatus: string | null; readonly cancelCutoffDays: number | null; readonly changeCutoffStatus: string | null } | null): Cutoffs {
  if (!row) return NO_CUTOFFS
  return {
    cancelStatus: isCutoffStatus(row.cancelCutoffStatus) ? row.cancelCutoffStatus : null,
    cancelDays: row.cancelCutoffDays,
    changeStatus: isCutoffStatus(row.changeCutoffStatus) ? row.changeCutoffStatus : null,
  }
}

/** The problems of cut-off settings as the office saves them, by path (body/…). */
export function cutoffProblems(input: { readonly cancelStatus: unknown; readonly cancelDays: unknown; readonly changeStatus: unknown }): Issue[] {
  const issues: Issue[] = []
  for (const [field, value] of [
    ['cancelCutoffStatus', input.cancelStatus],
    ['changeCutoffStatus', input.changeStatus],
  ] as const) {
    if (value !== null && !isCutoffStatus(value)) issues.push({ path: `body/${field}`, message: `A status of ${CUTOFF_STATUSES.join(', ')}, or none.` })
  }
  const days = input.cancelDays
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_CUTOFF_DAYS)) issues.push({ path: 'body/cancelCutoffDays', message: `Whole days from 1 to ${MAX_CUTOFF_DAYS}, or none.` })
  return issues
}

/** Whether `status` is at or past the cut-off (an order past READY is not asked about at all). */
const pastCutoff = (status: SalesOrderStatus, cutoff: CutoffStatus | null): boolean => {
  if (cutoff === null) return false
  const at = (CUTOFF_STATUSES as readonly string[]).indexOf(status)
  return at === -1 || at >= CUTOFF_STATUSES.indexOf(cutoff)
}

// ---- the facts ----------------------------------------------------------------------------------------------------------

/** The first cut of a line: the day, and whether it was leather cut on the table (a cut log) or a bundle made. */
export interface CutStart {
  readonly day: BusinessDate
  readonly leather: boolean
}

export interface RuleLine {
  readonly id: string
  readonly seq: number
  readonly kind: SalesLineKind
  readonly closedShort: boolean
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  /** null: nothing of it cut yet. */
  readonly cut: CutStart | null
}

export interface RuleOrder {
  readonly status: SalesOrderStatus
  readonly promiseDate: BusinessDate | null
  readonly lines: readonly RuleLine[]
  /** The day the order's OPEN request was asked; null: none waits. */
  readonly openRequestDay: BusinessDate | null
}

// ---- the verdicts -------------------------------------------------------------------------------------------------------

export const VERDICT_CODES = ['FREE', 'NOT_ASKABLE', 'OPEN_REQUEST', 'STATUS', 'DAYS', 'MADE_TO_MEASURE', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT', 'WHOLE_ORDER_ONLY'] as const
export type VerdictCode = (typeof VERDICT_CODES)[number]

/** What the rules say now, with the words the pop-up shows (before the click) and the refusal says (at the click). */
export interface Verdict {
  readonly possible: boolean
  readonly code: VerdictCode
  /** The day the words name (the cut, the open request, the promise), when they name one. */
  readonly day: BusinessDate | null
  readonly words: Words
}

const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
} as const

/** "12 Oct" / "12 ott" (a business day: no time zone moves it). */
export function dayWords(day: BusinessDate, locale: 'it' | 'en'): string {
  const [, month, date] = day.split('-')
  return `${Number(date)} ${MONTHS[locale][Number(month) - 1]}`
}

const STATUS_NAMES: Readonly<Record<SalesOrderStatus, Words>> = Object.freeze({
  CONFIRMED: { it: 'confermato', en: 'confirmed' },
  IN_PRODUCTION: { it: 'in produzione', en: 'in production' },
  READY: { it: 'pronto per la spedizione', en: 'ready to ship' },
  PARTLY_SHIPPED: { it: 'spedito in parte', en: 'partly shipped' },
  SHIPPED: { it: 'spedito', en: 'shipped' },
  CLOSED: { it: 'chiuso', en: 'closed' },
  CANCELLED: { it: 'annullato', en: 'cancelled' },
})

const verdict = (code: VerdictCode, words: Words, day: BusinessDate | null = null): Verdict => Object.freeze({ possible: code === 'FREE', code, day, words: Object.freeze({ ...words }) })

const FREE_WORDS: Readonly<Record<RequestKind, Words>> = Object.freeze({
  CHANGE: { it: 'Modificabile', en: 'Can change' },
  CANCEL: { it: 'Senza costi', en: 'Free' },
})

function statusCutoffWords(status: SalesOrderStatus, cutoff: CutoffStatus): Words {
  // A cut-off at CONFIRMED: never from the portal (the office takes such requests by mail or on the order's thread).
  if (cutoff === 'CONFIRMED' && status === 'CONFIRMED') return { it: "Non possibile dal portale: scrivici sull'ordine", en: 'Not possible from the portal: write to us on the order' }
  return { it: `Non possibile: ${STATUS_NAMES[status].it}`, en: `Not possible: ${STATUS_NAMES[status].en}` }
}

/** Whether the order takes a request of this kind at all, before its lines (state, an open request, the status cut-offs). */
export function orderVerdict(kind: RequestKind, order: RuleOrder, cutoffs: Cutoffs, today: BusinessDate): Verdict {
  if (!ASKABLE_STATUSES.includes(order.status)) {
    const name = STATUS_NAMES[order.status]
    return verdict('NOT_ASKABLE', { it: `Non possibile: l'ordine è già ${name.it}`, en: `Not possible: the order is already ${name.en}` })
  }
  if (order.openRequestDay !== null) {
    const day = order.openRequestDay
    return verdict('OPEN_REQUEST', { it: `La tua richiesta del ${dayWords(day, 'it')} attende la nostra risposta`, en: `Your request of ${dayWords(day, 'en')} waits for our answer` }, day)
  }
  const cutoff = kind === 'CHANGE' ? cutoffs.changeStatus : cutoffs.cancelStatus
  if (cutoff !== null && pastCutoff(order.status, cutoff)) return verdict('STATUS', statusCutoffWords(order.status, cutoff))
  if (kind === 'CANCEL' && cutoffs.cancelDays !== null && order.promiseDate !== null && order.promiseDate <= addDays(today, cutoffs.cancelDays)) {
    const day = order.promiseDate
    const days = cutoffs.cancelDays
    return verdict('DAYS', { it: `Non possibile entro ${days} giorni dalla consegna (${dayWords(day, 'it')})`, en: `Not possible within ${days} days of the delivery date (${dayWords(day, 'en')})` }, day)
  }
  // W2a's amendment takes no order with a made-to-measure unit: a change of such an order is agreed with the office.
  if (kind === 'CHANGE' && order.lines.some((line) => line.kind === 'MADE_TO_MEASURE')) {
    return verdict('MADE_TO_MEASURE', { it: 'Non possibile qui: un capo su misura si modifica direttamente con noi', en: 'Not possible here: a made-to-measure garment is changed with us directly' })
  }
  return verdict('FREE', FREE_WORDS[kind])
}

function cutVerdict(cut: CutStart): Verdict {
  return cut.leather
    ? verdict('LEATHER_CUT', { it: `Non possibile: la pelle è stata tagliata il ${dayWords(cut.day, 'it')}`, en: `Not possible: the leather was cut on ${dayWords(cut.day, 'en')}` }, cut.day)
    : verdict('CUT', { it: `Non possibile: il taglio è iniziato il ${dayWords(cut.day, 'it')}`, en: `Not possible: cutting started on ${dayWords(cut.day, 'en')}` }, cut.day)
}

/** What one line takes now: the order's verdict first, then the line's own (closed short, cut, made to measure). */
export function lineVerdict(kind: RequestKind, line: RuleLine, order: RuleOrder, cutoffs: Cutoffs, today: BusinessDate): Verdict {
  const whole = orderVerdict(kind, order, cutoffs, today)
  if (!whole.possible) return whole
  if (line.closedShort) return verdict('CLOSED_SHORT', { it: 'Non possibile: questa riga è chiusa', en: 'Not possible: this line is closed' })
  if (line.cut) return cutVerdict(line.cut)
  // A partial cancel removes its lines through the amendment, which takes no order with a made-to-measure unit.
  if (kind === 'CANCEL' && order.lines.some((entry) => entry.kind === 'MADE_TO_MEASURE')) {
    return verdict('WHOLE_ORDER_ONLY', { it: "Solo l'intero ordine: contiene un capo su misura", en: 'Only the whole order: it holds a made-to-measure garment' })
  }
  return whole
}

/** Whether the whole order may be asked to be cancelled: the order's verdict, then the earliest cut of any line. */
export function wholeCancelVerdict(order: RuleOrder, cutoffs: Cutoffs, today: BusinessDate): Verdict {
  const whole = orderVerdict('CANCEL', order, cutoffs, today)
  if (!whole.possible) return whole
  const cuts = order.lines.flatMap((line) => (line.cut ? [line.cut] : [])).sort((a, b) => a.day.localeCompare(b.day) || Number(b.leather) - Number(a.leather))
  return cuts.length > 0 ? cutVerdict(cuts[0]!) : whole
}

export interface Rules {
  /** May a change be asked at all (some line still free, or the date and address alone). */
  readonly change: Verdict
  /** May the whole order be asked to be cancelled. */
  readonly cancel: Verdict
  readonly lines: readonly { readonly lineId: string; readonly seq: number; readonly change: Verdict; readonly cancel: Verdict }[]
}

/** Everything the two pop-ups show before the click. */
export function rulesOf(order: RuleOrder, cutoffs: Cutoffs, today: BusinessDate): Rules {
  return {
    change: orderVerdict('CHANGE', order, cutoffs, today),
    cancel: wholeCancelVerdict(order, cutoffs, today),
    lines: order.lines.map((line) => ({ lineId: line.id, seq: line.seq, change: lineVerdict('CHANGE', line, order, cutoffs, today), cancel: lineVerdict('CANCEL', line, order, cutoffs, today) })),
  }
}

/** A refusal at the click: the verdict's English words, its code in the path (the web has both words already). */
export const refusalOf = (at: string, found: Verdict): Issue => ({ path: `${at}/${found.code}`, message: `${found.words.en}.` })

// ---- what is asked ------------------------------------------------------------------------------------------------------

/** One cell as stored (OrderChangeRequestLine): a line, a size (null: the line as a whole), the pieces before and asked. */
export interface AskedCell {
  readonly orderLineId: string
  readonly size: string | null
  readonly quantityBefore: number
  readonly quantity: number
}

export interface ChangeAsk {
  /** The sizes asked: the pieces wanted for each (0 drops the size). */
  readonly cells: readonly { readonly lineId: string; readonly size: string; readonly quantity: number }[]
  /** "We would like it by": the requested date asked (null or absent: unchanged). */
  readonly requestedDate?: BusinessDate | null | undefined
  /** One of their own delivery addresses (null or absent: unchanged). */
  readonly shipToAddressId?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface ChangeFacts {
  readonly order: RuleOrder
  readonly cutoffs: Cutoffs
  readonly today: BusinessDate
  /** The order's requested date now. */
  readonly requestedDate: BusinessDate | null
  /** The sizes each line may take: its own and those its style offers in its colourway (an active SKU). */
  readonly offered: ReadonlyMap<string, ReadonlySet<string>>
  /** The address asked is an ACTIVE delivery address of theirs (null: none asked). */
  readonly addressOk: boolean | null
}

const noteProblem = (note: string | null | undefined): Issue | null =>
  typeof note === 'string' && note.trim().length > MAX_NOTE ? { path: 'body/note', message: `At most ${MAX_NOTE} characters.` } : null

/** The problems of a change asked, in words, by path; a cut-off's refusal names its code (body/…/<CODE>). */
export function changeProblems(ask: ChangeAsk, facts: ChangeFacts): Issue[] {
  const whole = orderVerdict('CHANGE', facts.order, facts.cutoffs, facts.today)
  if (!whole.possible) return [refusalOf('body', whole)]
  const issues: Issue[] = []
  const lines = new Map(facts.order.lines.map((line) => [line.id, line]))
  const seen = new Set<string>()
  ask.cells.forEach((cell, index) => {
    const at = `body/cells/${index}`
    const line = lines.get(cell.lineId)
    if (!line) {
      issues.push({ path: `${at}/lineId`, message: 'Not a line of this order.' })
      return
    }
    const found = lineVerdict('CHANGE', line, facts.order, facts.cutoffs, facts.today)
    if (!found.possible) {
      issues.push(refusalOf(at, found))
      return
    }
    const key = `${cell.lineId}|${cell.size}`
    if (seen.has(key)) issues.push({ path: `${at}/size`, message: `Size ${cell.size} of line ${line.seq} is asked twice.` })
    seen.add(key)
    const before = line.sizes.find((entry) => entry.size === cell.size)?.quantity ?? 0
    if (!line.sizes.some((entry) => entry.size === cell.size) && !(facts.offered.get(line.id)?.has(cell.size) ?? false)) {
      issues.push({ path: `${at}/size`, message: `Size ${cell.size} is not made for line ${line.seq}.` })
    } else if (!Number.isInteger(cell.quantity) || cell.quantity < 0 || cell.quantity > MAX_SIZE_QUANTITY) {
      issues.push({ path: `${at}/quantity`, message: `Whole pieces from 0 to ${MAX_SIZE_QUANTITY}.` })
    } else if (cell.quantity === before) {
      issues.push({ path: `${at}/quantity`, message: `Size ${cell.size} of line ${line.seq} already has ${before} piece(s).` })
    }
  })
  if (issues.length > 0) return issues
  // Every piece of a line asked away is a cancel of that line, not a change (a cancelled line is closed, never removed: the
  // request keeps naming it).
  const after = new Map(facts.order.lines.map((line) => [line.id, line.sizes.reduce((total, size) => total + size.quantity, 0)]))
  for (const cell of ask.cells) {
    const line = lines.get(cell.lineId)!
    const before = line.sizes.find((entry) => entry.size === cell.size)?.quantity ?? 0
    after.set(line.id, after.get(line.id)! - before + cell.quantity)
  }
  for (const line of facts.order.lines) {
    if (ask.cells.some((cell) => cell.lineId === line.id) && after.get(line.id) === 0) issues.push({ path: 'body/cells', message: `Every piece of line ${line.seq} is asked away: ask to cancel that line instead.` })
  }
  const date = ask.requestedDate ?? null
  if (date !== null) {
    if (date < facts.today) issues.push({ path: 'body/requestedDate', message: 'A date from today on.' })
    else if (date === facts.requestedDate) issues.push({ path: 'body/requestedDate', message: 'The order already asks for this date.' })
  }
  if (facts.addressOk === false) issues.push({ path: 'body/shipToAddressId', message: 'One of your delivery addresses, still in use.' })
  const note = noteProblem(ask.note)
  if (note) issues.push(note)
  if (ask.cells.length === 0 && date === null && (ask.shipToAddressId ?? null) === null) issues.push({ path: 'body', message: 'Say what should change: sizes, the date or the delivery address.' })
  return issues
}

/** The cells a change stores: the pieces before, read from the order now. */
export function changeCellsOf(ask: ChangeAsk, order: RuleOrder): AskedCell[] {
  const lines = new Map(order.lines.map((line) => [line.id, line]))
  return ask.cells.map((cell) => ({ orderLineId: cell.lineId, size: cell.size, quantityBefore: lines.get(cell.lineId)?.sizes.find((entry) => entry.size === cell.size)?.quantity ?? 0, quantity: cell.quantity }))
}

export interface CancelAsk {
  /** The lines to cancel; none (or every line): the whole order. */
  readonly lineIds?: readonly string[] | undefined
  /** A code of the CANCEL reason list. */
  readonly reasonCode: string
  readonly note?: string | null | undefined
}

export interface CancelFacts {
  readonly order: RuleOrder
  readonly cutoffs: Cutoffs
  readonly today: BusinessDate
  /** The CANCEL reasons in use, by code: whether the reason asks for their words ("Other"). */
  readonly reasons: ReadonlyMap<string, { readonly needsNote: boolean }>
}

/** Whether the cancel asks for the whole order (no lines, or every line). */
export const isWholeCancel = (ask: Pick<CancelAsk, 'lineIds'>, order: Pick<RuleOrder, 'lines'>): boolean => {
  const asked = new Set(ask.lineIds ?? [])
  return asked.size === 0 || order.lines.every((line) => asked.has(line.id))
}

/** The problems of a cancel asked, in words, by path; a cut-off's refusal names its code. */
export function cancelProblems(ask: CancelAsk, facts: CancelFacts): Issue[] {
  const issues: Issue[] = []
  const reason = facts.reasons.get(ask.reasonCode)
  if (!reason) issues.push({ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' })
  else if (reason.needsNote && (typeof ask.note !== 'string' || ask.note.trim() === '')) issues.push({ path: 'body/note', message: 'Say why in a few words.' })
  const note = noteProblem(ask.note)
  if (note) issues.push(note)
  if (isWholeCancel(ask, facts.order)) {
    const found = wholeCancelVerdict(facts.order, facts.cutoffs, facts.today)
    if (!found.possible) issues.unshift(refusalOf('body', found))
    return issues
  }
  const lines = new Map(facts.order.lines.map((line) => [line.id, line]))
  const seen = new Set<string>()
  ;(ask.lineIds ?? []).forEach((lineId, index) => {
    const at = `body/lineIds/${index}`
    const line = lines.get(lineId)
    if (!line) {
      issues.push({ path: at, message: 'Not a line of this order.' })
      return
    }
    if (seen.has(lineId)) issues.push({ path: at, message: `Line ${line.seq} is asked twice.` })
    seen.add(lineId)
    const found = lineVerdict('CANCEL', line, facts.order, facts.cutoffs, facts.today)
    if (!found.possible) issues.push(refusalOf(at, found))
  })
  return issues
}

/** The cells a cancel stores: none for the whole order; else one per line, as a whole, asking 0. */
export function cancelCellsOf(ask: CancelAsk, order: RuleOrder): AskedCell[] {
  if (isWholeCancel(ask, order)) return []
  const lines = new Map(order.lines.map((line) => [line.id, line]))
  return [...new Set(ask.lineIds ?? [])].map((lineId) => ({ orderLineId: lineId, size: null, quantityBefore: lines.get(lineId)?.sizes.reduce((total, size) => total + size.quantity, 0) ?? 0, quantity: 0 }))
}

// ---- the office's answer --------------------------------------------------------------------------------------------------

/** The office's words to the customer: required to refuse, optional to accept. */
export function answerProblems(answer: 'ACCEPTED' | 'REFUSED', words: string | null | undefined): Issue[] {
  const text = typeof words === 'string' ? words.trim() : ''
  if (answer === 'REFUSED' && text === '') return [{ path: 'body/answer', message: 'Say why the request is not accepted: the customer reads it.' }]
  if (text.length > MAX_ANSWER) return [{ path: 'body/answer', message: `At most ${MAX_ANSWER} characters.` }]
  return []
}

/**
 * The amendment's lines for an accepted change (W2a's amendment takes the order's lines as they should be): every line
 * named, a line asked about with its sizes as asked (a size at 0 dropped). `changed`: whether any line changes at all (a
 * change of the date or the address alone makes no line change). A cancel of lines is not an amendment: the lines are
 * closed short (W2a's close, with the request's CANCEL code), so the request keeps naming them.
 */
export function amendmentLinesOf(cells: readonly AskedCell[], lines: readonly Pick<RuleLine, 'id' | 'sizes'>[]): { readonly lines: AmendLineInput[]; readonly changed: boolean } {
  const byLine = new Map<string, AskedCell[]>()
  for (const cell of cells) byLine.set(cell.orderLineId, [...(byLine.get(cell.orderLineId) ?? []), cell])
  const out: AmendLineInput[] = lines.map((line) => {
    const asked = byLine.get(line.id)
    if (!asked) return { id: line.id }
    const sizes = new Map(line.sizes.map((size) => [size.size, size.quantity]))
    for (const cell of asked) if (cell.size !== null) sizes.set(cell.size, cell.quantity)
    return { id: line.id, sizes: [...sizes.entries()].filter(([, quantity]) => quantity > 0).map(([size, quantity]) => ({ size, quantity })) }
  })
  return { lines: out, changed: cells.length > 0 }
}

/** What a request asks, counted (Today's sentence and the office list). */
export function askedSummary(kind: RequestKind, cells: readonly AskedCell[], header: { readonly requestedDate: BusinessDate | null; readonly shipToAddressId: string | null }) {
  return {
    sizes: kind === 'CHANGE' ? cells.filter((cell) => cell.size !== null).length : 0,
    lines: new Set(cells.map((cell) => cell.orderLineId)).size,
    date: header.requestedDate !== null,
    address: header.shipToAddressId !== null,
    wholeOrder: kind === 'CANCEL' && cells.length === 0,
  }
}
