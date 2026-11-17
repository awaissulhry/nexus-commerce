import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { AmendLineInput } from '../amendments/amendments'
import { LINE_CHANGE_STATUSES, type SalesOrderStatus } from '../orders/orders'
import { addDays, MAX_SIZE_QUANTITY, type SalesLineKind } from '../quotes/quotes'
import { PRODUCTION_REQUEST_KINDS } from '../../production-brand/kinds' // B-PR-23
// B-PR-24: the production asks' rules (which are open, who answers them, the customer's words).
import type { Permission } from '../../core/permissions'
import { isAskOpen, type AskLimits, type ProductionRequestKind } from '../../production-brand/kinds'
import { PRODUCTION_BRAND_MANAGE } from '../../production-brand/permissions'
import type { BrandUrgency } from '../../production-brand/urgency'
import { ASK_NOT_OPEN_WORDS, setBackWords } from '../../production-brand/words'
import { ORDERS_MANAGE } from '../orders/permissions'
import { SALES_SAMPLES_MANAGE } from '../samples/permissions'

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

// B-PR-23 (production plan, schema wave 4/5): COUNTERED, the office's counter-offer waiting for the customer's answer.
export const REQUEST_STATUSES = ['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN', 'COUNTERED'] as const
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
  // B-PR-23
  COUNTERED: { it: 'Controproposta: in attesa della tua risposta', en: 'Our counter-offer: waiting for your answer' },
})

// ---- B-PR-23 (production plan, schema wave 4/5; review fixes R-14, R-50): every kind a request may be ------------------------

/**
 * Every kind of request on an order (the schema's OrderChangeRequestKind): the portal's CHANGE and CANCEL and the production
 * asks (production-brand/kinds). Sales answers CHANGE and CANCEL (orders.manage, /sales/change-requests); the production asks
 * are answered in Home › Approvals (B-PR-26, B-PR-27a/b) — every read of an order's requests says each kind in words.
 */
export const ORDER_REQUEST_KINDS = [...REQUEST_KINDS, ...PRODUCTION_REQUEST_KINDS] as const
export type OrderRequestKind = (typeof ORDER_REQUEST_KINDS)[number]

/** A kind Sales answers (and the portal's own ask route takes, until B-PR-25): CHANGE or CANCEL. */
export const isSalesRequestKind = (kind: string): kind is RequestKind => (REQUEST_KINDS as readonly string[]).includes(kind)

/** Every request in words, as an order's list of requests names it (the customer's and the office's). */
export const ORDER_REQUEST_KIND_WORDS: Readonly<Record<OrderRequestKind, Words>> = Object.freeze({
  ...KIND_WORDS,
  RUSH: { it: 'Urgente – richiesto', en: 'Urgent – asked' },
  HOLD: { it: 'Richiesta di pausa', en: 'Pause request' },
  RESUME: { it: 'Richiesta di ripresa', en: 'Resume request' },
  SPLIT_SHIPMENT: { it: 'Richiesta di spedire ciò che è pronto', en: 'Request to ship what is ready' },
  SAMPLE_ROUND: { it: 'Richiesta di un altro campione', en: 'Request for another sample' },
})

/**
 * The states that wait for an answer: OPEN (ours) and COUNTERED (the customer's, to our counter-offer). One request that waits
 * per order and kind (review fix R-14); the portal's CHANGE and CANCEL keep one that waits between them (today's rule), and a
 * production ask never blocks them. The API serialises it per order (a partial unique cannot stand beside the generated
 * isolation tests).
 */
export const WAITING_REQUEST_STATUSES = ['OPEN', 'COUNTERED'] as const satisfies readonly RequestStatus[]
export const isWaitingRequest = (status: string): boolean => (WAITING_REQUEST_STATUSES as readonly string[]).includes(status)

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
  /** B-PR-26: it shipped in full (a PARTLY_SHIPPED order's line: nothing of it is left to cancel); undefined: taken as not. */
  readonly shippedInFull?: boolean | undefined
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
  PENDING_APPROVAL: { it: 'in attesa di approvazione', en: 'waiting for a yes' },
  DELIVERED: { it: 'consegnato', en: 'delivered' },
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

// B-PR-26: a partly shipped order's cancel (close short of what is still to ship).
const PARTLY_SHIPPED: SalesOrderStatus = 'PARTLY_SHIPPED'
const SHIPPED_IN_FULL_WORDS: Words = Object.freeze({ it: 'Non possibile: questa riga è già spedita per intero', en: 'Not possible: this line shipped in full' })
const NOTHING_LEFT_WORDS: Words = Object.freeze({ it: "Non possibile: dell'ordine è già spedito tutto", en: 'Not possible: everything of the order has shipped' })

/** Whether the order takes a request of this kind at all, before its lines (state, an open request, the status cut-offs). */
export function orderVerdict(kind: RequestKind, order: RuleOrder, cutoffs: Cutoffs, today: BusinessDate): Verdict {
  // B-PR-26 (plan §3 "A partly shipped order may still ask to cancel unshipped lines (close short)"; review fix R-35): a cancel
  // of what is still to ship is asked of a PARTLY_SHIPPED order too (the company's cut-offs still apply).
  if (!ASKABLE_STATUSES.includes(order.status) && !(kind === 'CANCEL' && order.status === PARTLY_SHIPPED)) {
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
  // B-PR-26: a line of a partly shipped order that shipped in full has nothing left to cancel.
  if (order.status === PARTLY_SHIPPED && line.shippedInFull === true) return verdict('NOT_ASKABLE', SHIPPED_IN_FULL_WORDS)
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
  // B-PR-26: a partly shipped order's "whole order" is what is still to ship (its lines closed short at the answer).
  const left = order.status === PARTLY_SHIPPED ? order.lines.filter((line) => !line.closedShort && line.shippedInFull !== true) : order.lines
  if (order.status === PARTLY_SHIPPED && left.length === 0) return verdict('NOT_ASKABLE', NOTHING_LEFT_WORDS)
  const cuts = left.flatMap((line) => (line.cut ? [line.cut] : [])).sort((a, b) => a.day.localeCompare(b.day) || Number(b.leather) - Number(a.leather))
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
// B-PR-23: any kind of request (a production ask says no sizes and is never a whole-order cancel).
export function askedSummary(kind: OrderRequestKind, cells: readonly AskedCell[], header: { readonly requestedDate: BusinessDate | null; readonly shipToAddressId: string | null }) {
  return {
    sizes: kind === 'CHANGE' ? cells.filter((cell) => cell.size !== null).length : 0,
    lines: new Set(cells.map((cell) => cell.orderLineId)).size,
    date: header.requestedDate !== null,
    address: header.shipToAddressId !== null,
    wholeOrder: kind === 'CANCEL' && cells.length === 0,
  }
}

// ---- B-PR-24 (production plan §3 "Brand asks, we decide" and its plain rules; 08-backend §4.2; lead picks L4, L18; review
// fixes R-12, R-14, R-35, R-50): every kind of ask — what it needs, when it is asked, what accepting it does, who answers -----

/**
 * The customer asks, we decide. What each kind of request needs, when it may be asked and what accepting it does (the
 * database guards the shape of each: …_brand_asks_guards; these say it first, in words):
 *
 *   CHANGE          sizes, quantities, another colourway of the line's style, the date, the delivery address; today's cut-offs
 *                   (rulesOf); accepted as the amendment — but once a line's work is released (cells change only in a DRAFT
 *                   work order) only as cancel-and-remake or close short, and the pieces already made are a task for the floor
 *                   lead (changeAcceptWays; R-12)
 *   CANCEL          the whole order or some lines, a reason code; today's cut-offs; accepted as the order cancelled or the lines
 *                   closed short (a PARTLY_SHIPPED order: its unshipped lines, R-35)
 *   RUSH            "Urgent – asked": open exactly while the customer's urgency switch is on, never through the list of asks
 *                   (R-50); the whole order, an optional need-by date (earlier than the promise), their words; not once
 *                   everything is ready, not while we locked the order at Regular, an order already Urgent only with a need-by
 *                   date; accepted as the order marked Urgent (it may pass the quota: "agreed with us") and its date looked at
 *                   again — or, the planner's own lever, also rushed on the floor (B-PR-27b)
 *   HOLD            a pause: open through the limits' list; the whole order and why (their words, or a code of the list when
 *                   one is offered); not once everything is ready, not while a pause is on; accepted as a BRAND hold on each
 *                   open work order of the order (B-PR-27a)
 *   RESUME          open through the list; only while a pause it asked is on (the database: an ACCEPTED HOLD; the holds still
 *                   active: the API's); accepted as the order's BRAND holds lifted
 *   SPLIT_SHIPMENT  "ship what is ready": open through the list; the first part's cells (1 to the pieces of each, never the
 *                   whole order) and its date (optional); only while the order ships complete; accepted as the order shipping
 *                   as ready and the first part's date looked at again
 *   SAMPLE_ROUND    another sample: open through the list; one line and the kind of round (pre-production and size set only
 *                   before the line's cutting started); accepted as a sample round of that kind
 *
 * One request that waits (OPEN or COUNTERED) per order and kind (R-14). A closed ask is refused in neutral words (it never says
 * that another customer may). Answered in the office with the kind's permission (plan §3): CHANGE, CANCEL, SPLIT_SHIPMENT
 * orders.manage; RUSH, HOLD, RESUME production.brand.manage; SAMPLE_ROUND sales.samples.manage.
 */

/** What accepting a request does, one step each (B-PR-27a/b carry them out in the accept's one command). */
export const ACCEPT_ACTIONS = ['AMEND', 'CANCEL_AND_REMAKE', 'CLOSE_SHORT', 'CANCEL_ORDER', 'MARK_URGENT', 'RUSH_FLOOR', 'REPROMISE', 'BRAND_HOLD', 'LIFT_BRAND_HOLDS', 'SHIP_AS_READY', 'SAMPLE_ROUND'] as const
export type AcceptAction = (typeof ACCEPT_ACTIONS)[number]

/** The kinds of sample round a customer may ask for (the database's four). */
export const ASK_SAMPLE_KINDS = ['PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND'] as const
export type AskSampleKind = (typeof ASK_SAMPLE_KINDS)[number]
/** The rounds that come before production: asked only before the line's cutting started. */
export const BEFORE_CUT_SAMPLE_KINDS: readonly AskSampleKind[] = Object.freeze(['PRE_PRODUCTION', 'SIZE_SET'])

export interface AskRule {
  readonly kind: OrderRequestKind
  /** The order statuses it may be asked in (the database's; the rules below may still hold it). */
  readonly statuses: readonly SalesOrderStatus[]
  /** What it names of the order: nothing (the whole order), cells or lines (some, or none for the whole order), one line. */
  readonly lines: 'NONE' | 'OPTIONAL' | 'WHOLE_OR_SOME' | 'SOME' | 'ONE'
  /** It may carry a date (the change's, the rush's need-by date, the first part's). */
  readonly date: boolean
  readonly reasonCode: 'NONE' | 'OPTIONAL' | 'REQUIRED'
  /** It names the kind of sample round. */
  readonly sampleKind: boolean
  /** The office permission that answers it (over the order's company and customer). */
  readonly answeredWith: Permission
  /** What accepting it may do (the first is the plain accept). */
  readonly accept: readonly AcceptAction[]
  /** What accepting it does, as the customer reads it before Send and the office before Accept. */
  readonly acceptWords: Words
  /** We may answer it with a counter-offer (./counter). */
  readonly counter: boolean
}

const askRule = (spec: AskRule): AskRule => Object.freeze({ ...spec, statuses: Object.freeze([...spec.statuses]), accept: Object.freeze([...spec.accept]), acceptWords: Object.freeze({ ...spec.acceptWords }) })
/** CONFIRMED, IN_PRODUCTION, READY and a PARTLY_SHIPPED order (review fix R-35: a cancel of its unshipped lines, a rush, a pause, a resume). */
const WITH_PART_SHIPPED: readonly SalesOrderStatus[] = [...ASKABLE_STATUSES, 'PARTLY_SHIPPED']

export const ASK_RULES: Readonly<Record<OrderRequestKind, AskRule>> = Object.freeze({
  CHANGE: askRule({
    kind: 'CHANGE',
    statuses: ASKABLE_STATUSES,
    lines: 'OPTIONAL',
    date: true,
    reasonCode: 'NONE',
    sampleKind: false,
    answeredWith: ORDERS_MANAGE,
    accept: ['AMEND', 'CANCEL_AND_REMAKE', 'CLOSE_SHORT'],
    acceptWords: {
      it: "Modifichiamo l'ordine come richiesto. Una riga già in produzione cambia taglie e quantità solo annullandola e rifacendola, o chiudendola prima.",
      en: 'We change the order as asked. A line already in production changes its sizes and quantities only by cancelling and remaking it, or by closing it short.',
    },
    counter: true,
  }),
  CANCEL: askRule({
    kind: 'CANCEL',
    statuses: WITH_PART_SHIPPED,
    lines: 'WHOLE_OR_SOME',
    date: false,
    reasonCode: 'REQUIRED',
    sampleKind: false,
    answeredWith: ORDERS_MANAGE,
    accept: ['CANCEL_ORDER', 'CLOSE_SHORT'],
    acceptWords: { it: "Annulliamo l'ordine, o chiudiamo le righe richieste: non ne produciamo né spediamo altro.", en: 'We cancel the order, or close the lines asked short: nothing more of them is made or shipped.' },
    counter: true,
  }),
  RUSH: askRule({
    kind: 'RUSH',
    statuses: WITH_PART_SHIPPED,
    lines: 'NONE',
    date: true,
    reasonCode: 'NONE',
    sampleKind: false,
    answeredWith: PRODUCTION_BRAND_MANAGE,
    accept: ['MARK_URGENT', 'REPROMISE', 'RUSH_FLOOR'],
    acceptWords: { it: "Segniamo l'ordine come urgente e rivediamo la sua data.", en: 'We mark the order Urgent and look at its date again.' },
    counter: true,
  }),
  HOLD: askRule({
    kind: 'HOLD',
    statuses: WITH_PART_SHIPPED,
    lines: 'NONE',
    date: false,
    reasonCode: 'OPTIONAL',
    sampleKind: false,
    answeredWith: PRODUCTION_BRAND_MANAGE,
    accept: ['BRAND_HOLD'],
    acceptWords: { it: "Mettiamo in pausa la lavorazione dell'ordine finché non ci chiedi di riprendere.", en: 'We pause the work on the order until you ask us to resume it.' },
    counter: true,
  }),
  RESUME: askRule({
    kind: 'RESUME',
    statuses: WITH_PART_SHIPPED,
    lines: 'NONE',
    date: false,
    reasonCode: 'NONE',
    sampleKind: false,
    answeredWith: PRODUCTION_BRAND_MANAGE,
    accept: ['LIFT_BRAND_HOLDS'],
    acceptWords: { it: "Riprendiamo la lavorazione dell'ordine.", en: 'We take the work on the order up again.' },
    // The pause is the customer's to end: a resume is accepted or refused, never countered.
    counter: false,
  }),
  SPLIT_SHIPMENT: askRule({
    kind: 'SPLIT_SHIPMENT',
    statuses: ASKABLE_STATUSES,
    lines: 'SOME',
    date: true,
    reasonCode: 'NONE',
    sampleKind: false,
    answeredWith: ORDERS_MANAGE,
    accept: ['SHIP_AS_READY', 'REPROMISE'],
    acceptWords: { it: 'Spediamo prima ciò che è pronto e diamo alla prima parte una sua data.', en: 'We ship what is ready first and give the first part its own date.' },
    counter: true,
  }),
  SAMPLE_ROUND: askRule({
    kind: 'SAMPLE_ROUND',
    statuses: ASKABLE_STATUSES,
    lines: 'ONE',
    date: false,
    reasonCode: 'NONE',
    sampleKind: true,
    answeredWith: SALES_SAMPLES_MANAGE,
    accept: ['SAMPLE_ROUND'],
    acceptWords: { it: 'Facciamo un altro giro di campionatura del tipo richiesto.', en: 'We make another sample round of the kind asked.' },
    counter: true,
  }),
})

// ---- whether a production ask may be asked now --------------------------------------------------------------------------

export const ASK_VERDICT_CODES = ['FREE', 'NOT_OPEN', 'NOT_ASKABLE', 'WAITING', 'READY', 'LOCKED', 'ALREADY_URGENT', 'PAUSED', 'NOT_PAUSED', 'SHIPS_AS_READY', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT'] as const
export type AskVerdictCode = (typeof ASK_VERDICT_CODES)[number]

/** What the rules say of a production ask now, in the customer's words (before the click and at it). */
export interface AskVerdict {
  readonly possible: boolean
  readonly code: AskVerdictCode
  readonly day: BusinessDate | null
  readonly words: Words
}

const askVerdict_ = (code: AskVerdictCode, words: Words, day: BusinessDate | null = null): AskVerdict => Object.freeze({ possible: code === 'FREE', code, day, words: Object.freeze({ ...words }) })

/** The order's urgency now, as a rush reads it (BrandOrderProduction; null: no production row yet — Regular). */
export interface AskUrgency {
  readonly urgency: BrandUrgency
  readonly locked: boolean
  readonly lockReason: string | null
}

/** The facts a production ask is read against (the API reads them in the customer's own scope, live). */
export interface AskFacts {
  readonly order: Pick<RuleOrder, 'status' | 'promiseDate' | 'lines'>
  /** What the factory opened to the customer (PortalSettings.productionUrgencyOn, productionAskKinds). */
  readonly limits: AskLimits
  /** The day the waiting (OPEN or COUNTERED) request of this kind on the order was asked; null: none waits. */
  readonly waitingDay: BusinessDate | null
  /** Every open line of the order is ready to ship (all released by quality: the order READY, or its rest after a part shipped). */
  readonly ready: boolean
  /** A pause it asked is on: an ACCEPTED HOLD whose BRAND holds are still active (the partner reads no hold: the API's). */
  readonly pauseOn: boolean
  readonly urgency: AskUrgency | null
  /** SalesOrder.shipComplete: the order waits to ship as one. */
  readonly shipComplete: boolean
}

const FREE_ASK_WORDS: Words = Object.freeze({ it: 'Puoi chiederlo: decidiamo noi e ti rispondiamo', en: 'You can ask: we decide and answer you' })

/** Whether the order takes a production ask of this kind now, before what it names (the order, a waiting ask, the kind's own state). */
export function askVerdict(kind: ProductionRequestKind, facts: AskFacts): AskVerdict {
  if (!isAskOpen(kind, facts.limits)) return askVerdict_('NOT_OPEN', ASK_NOT_OPEN_WORDS)
  const status = facts.order.status
  if (!ASK_RULES[kind].statuses.includes(status)) {
    const name = STATUS_NAMES[status]
    return askVerdict_('NOT_ASKABLE', { it: `Non possibile: l'ordine è già ${name.it}`, en: `Not possible: the order is already ${name.en}` })
  }
  if (facts.waitingDay !== null) {
    const day = facts.waitingDay
    return askVerdict_('WAITING', { it: `La tua richiesta del ${dayWords(day, 'it')} attende la nostra risposta`, en: `Your request of ${dayWords(day, 'en')} waits for our answer` }, day)
  }
  switch (kind) {
    case 'RUSH':
      if (facts.ready) return askVerdict_('READY', { it: 'Non serve: è già tutto pronto per la spedizione', en: 'No need: everything is ready to ship already' })
      if (facts.urgency?.locked) return askVerdict_('LOCKED', setBackWords(facts.urgency.lockReason))
      break
    case 'HOLD':
      if (facts.ready) return askVerdict_('READY', { it: "È già tutto pronto per la spedizione: per fermare la spedizione scrivici nella conversazione dell'ordine", en: "Everything is ready to ship already: to hold the shipment, write to us in the order's thread" })
      if (facts.pauseOn) return askVerdict_('PAUSED', { it: "L'ordine è già in pausa: chiedici di riprendere quando vuoi", en: 'The order is paused already: ask us to resume it when you are ready' })
      break
    case 'RESUME':
      if (!facts.pauseOn) return askVerdict_('NOT_PAUSED', { it: "L'ordine non è in pausa", en: 'The order is not paused' })
      break
    case 'SPLIT_SHIPMENT':
      if (!facts.shipComplete) return askVerdict_('SHIPS_AS_READY', { it: "L'ordine si spedisce già a parti, man mano che sono pronte", en: 'The order already ships in parts as they are ready' })
      break
    case 'SAMPLE_ROUND':
      break
  }
  return askVerdict_('FREE', FREE_ASK_WORDS)
}

/** What one line takes for a ship-what-is-ready or a sample round: the order's verdict first, then the line's own. */
export function askLineVerdict(kind: 'SPLIT_SHIPMENT' | 'SAMPLE_ROUND', line: RuleLine, facts: AskFacts, sampleKind: AskSampleKind | null = null): AskVerdict {
  const whole = askVerdict(kind, facts)
  if (!whole.possible) return whole
  if (line.closedShort) return askVerdict_('CLOSED_SHORT', { it: 'Non possibile: questa riga è chiusa', en: 'Not possible: this line is closed' })
  if (kind === 'SAMPLE_ROUND' && sampleKind !== null && BEFORE_CUT_SAMPLE_KINDS.includes(sampleKind) && line.cut) {
    const cut = line.cut
    return cut.leather
      ? askVerdict_('LEATHER_CUT', { it: `Non possibile: la pelle è stata tagliata il ${dayWords(cut.day, 'it')}. Puoi chiedere i primi capi di produzione (TOP)`, en: `Not possible: the leather was cut on ${dayWords(cut.day, 'en')}. You can ask for a top-of-production sample` }, cut.day)
      : askVerdict_('CUT', { it: `Non possibile: il taglio è iniziato il ${dayWords(cut.day, 'it')}. Puoi chiedere i primi capi di produzione (TOP)`, en: `Not possible: cutting started on ${dayWords(cut.day, 'en')}. You can ask for a top-of-production sample` }, cut.day)
  }
  return whole
}

/** A production ask's refusal at the click: its English words, its code in the path. */
export const askRefusalOf = (at: string, found: AskVerdict): Issue => ({ path: `${at}/${found.code}`, message: `${found.words.en}.` })

// ---- what a production ask names, and its problems ------------------------------------------------------------------------

/** A production ask as the customer sends it (one order). */
export interface ProductionAsk {
  readonly kind: ProductionRequestKind
  /** RUSH: the need-by date; SPLIT_SHIPMENT: the first part's date (both optional). */
  readonly requestedDate?: BusinessDate | null | undefined
  /** HOLD: a code of the reason list, when one is offered. */
  readonly reasonCode?: string | null | undefined
  /** Their words (HOLD: why, when no code says it). */
  readonly note?: string | null | undefined
  /** SPLIT_SHIPMENT: the first part, the pieces of each size that should ship first. */
  readonly cells?: readonly { readonly lineId: string; readonly size: string; readonly quantity: number }[] | undefined
  /** SAMPLE_ROUND: the line the sample is of. */
  readonly lineId?: string | null | undefined
  /** SAMPLE_ROUND: the kind of round. */
  readonly sampleKind?: string | null | undefined
}

export interface ProductionAskFacts extends AskFacts {
  readonly today: BusinessDate
  /** HOLD: the reason codes offered, by code (none offered: their words say why). */
  readonly holdReasons?: ReadonlyMap<string, { readonly needsNote: boolean }> | undefined
}

const isAskSampleKind = (value: unknown): value is AskSampleKind => typeof value === 'string' && (ASK_SAMPLE_KINDS as readonly string[]).includes(value)
const filled = (text: string | null | undefined): boolean => typeof text === 'string' && text.trim() !== ''

/** The problems of a production ask, in words, by path; a closed or held ask names its code (body/<CODE>). */
export function productionAskProblems(ask: ProductionAsk, facts: ProductionAskFacts): Issue[] {
  const rule = ASK_RULES[ask.kind]
  const whole = askVerdict(ask.kind, facts)
  if (!whole.possible) return [askRefusalOf('body', whole)]
  const issues: Issue[] = []
  // What the kind does not name (the database refuses each too).
  const date = ask.requestedDate ?? null
  if (!rule.date && date !== null) issues.push({ path: 'body/requestedDate', message: 'A pause, a resume or a sample round asks no date.' })
  if (rule.reasonCode === 'NONE' && filled(ask.reasonCode)) issues.push({ path: 'body/reasonCode', message: 'This ask takes no reason code: say it in your words.' })
  if (rule.lines !== 'SOME' && (ask.cells?.length ?? 0) > 0) issues.push({ path: 'body/cells', message: 'This ask is for the whole order: name no sizes.' })
  if (rule.lines !== 'ONE' && filled(ask.lineId)) issues.push({ path: 'body/lineId', message: 'This ask is for the whole order: name no line.' })
  if (!rule.sampleKind && filled(ask.sampleKind)) issues.push({ path: 'body/sampleKind', message: 'Only a sample round names the kind of sample.' })
  const note = noteProblem(ask.note)
  if (note) issues.push(note)
  if (rule.date && date !== null && date < facts.today) issues.push({ path: 'body/requestedDate', message: 'A date from today on.' })
  const lines = new Map(facts.order.lines.map((line) => [line.id, line]))
  switch (ask.kind) {
    case 'RUSH': {
      const promise = facts.order.promiseDate
      if (date !== null && promise !== null && date >= promise && date >= facts.today) {
        issues.push({ path: 'body/requestedDate', message: `The order is promised for ${dayWords(promise, 'en')} already: the date you need it by is earlier than that.` })
      }
      if (date === null && facts.urgency?.urgency === 'URGENT') {
        issues.push(askRefusalOf('body', askVerdict_('ALREADY_URGENT', { it: "L'ordine è già urgente: indica la data entro cui ti serve per chiedere di più", en: 'The order is urgent already: give the date you need it by to ask for more' })))
      }
      break
    }
    case 'HOLD': {
      const code = filled(ask.reasonCode) ? ask.reasonCode!.trim() : null
      if (code !== null) {
        const reason = facts.holdReasons?.get(code)
        if (!reason) issues.push({ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' })
        else if (reason.needsNote && !filled(ask.note)) issues.push({ path: 'body/note', message: 'Say why in a few words.' })
      } else if (!filled(ask.note)) {
        issues.push({ path: 'body/note', message: 'Say why you want to pause, in a few words.' })
      }
      break
    }
    case 'RESUME':
      break
    case 'SPLIT_SHIPMENT': {
      const cells = ask.cells ?? []
      if (cells.length === 0) {
        issues.push({ path: 'body/cells', message: 'Name what should ship first: the pieces of each size.' })
        break
      }
      const seen = new Set<string>()
      cells.forEach((cell, index) => {
        const at = `body/cells/${index}`
        const line = lines.get(cell.lineId)
        if (!line) {
          issues.push({ path: `${at}/lineId`, message: 'Not a line of this order.' })
          return
        }
        const found = askLineVerdict('SPLIT_SHIPMENT', line, facts)
        if (!found.possible) {
          issues.push(askRefusalOf(at, found))
          return
        }
        const key = `${cell.lineId}|${cell.size}`
        if (seen.has(key)) issues.push({ path: `${at}/size`, message: `Size ${cell.size} of line ${line.seq} is named twice.` })
        seen.add(key)
        const pieces = line.sizes.find((entry) => entry.size === cell.size)?.quantity ?? 0
        if (pieces <= 0) issues.push({ path: `${at}/size`, message: `Size ${cell.size} is not on line ${line.seq}.` })
        else if (!Number.isInteger(cell.quantity) || cell.quantity < 1 || cell.quantity > pieces) issues.push({ path: `${at}/quantity`, message: `From 1 to ${pieces} piece(s).` })
      })
      if (issues.length > 0) break
      // Every piece of every open line first is the whole order: it ships as one already.
      const asked = new Map(cells.map((cell) => [`${cell.lineId}|${cell.size}`, cell.quantity]))
      const open = facts.order.lines.filter((line) => !line.closedShort)
      if (open.every((line) => line.sizes.every((size) => size.quantity <= 0 || asked.get(`${line.id}|${size.size}`) === size.quantity))) {
        issues.push({ path: 'body/cells', message: 'That is the whole order: it ships as one already. Name only what should ship first.' })
      }
      break
    }
    case 'SAMPLE_ROUND': {
      const kind = isAskSampleKind(ask.sampleKind) ? ask.sampleKind : null
      if (kind === null) issues.push({ path: 'body/sampleKind', message: 'Pick the kind of sample: pre-production, size set, top of production or your brand sample.' })
      const line = filled(ask.lineId) ? lines.get(ask.lineId!) : undefined
      if (!line) {
        issues.push({ path: 'body/lineId', message: 'Pick the line of this order the sample is of.' })
        break
      }
      const found = askLineVerdict('SAMPLE_ROUND', line, facts, kind)
      if (!found.possible) issues.push(askRefusalOf('body/lineId', found))
      break
    }
  }
  return issues
}

/** The cells a production ask stores (OrderChangeRequestLine): the first part of a split, the one line of a sample round. */
export function productionCellsOf(ask: ProductionAsk, order: Pick<RuleOrder, 'lines'>): AskedCell[] {
  const lines = new Map(order.lines.map((line) => [line.id, line]))
  if (ask.kind === 'SPLIT_SHIPMENT') {
    return (ask.cells ?? []).map((cell) => ({ orderLineId: cell.lineId, size: cell.size, quantityBefore: lines.get(cell.lineId)?.sizes.find((entry) => entry.size === cell.size)?.quantity ?? 0, quantity: cell.quantity }))
  }
  if (ask.kind === 'SAMPLE_ROUND' && filled(ask.lineId)) {
    const line = lines.get(ask.lineId!)
    // One sample of the line: the row names the line as a whole (its pieces before), asking one piece.
    return [{ orderLineId: ask.lineId!, size: null, quantityBefore: line?.sizes.reduce((total, size) => total + size.quantity, 0) ?? 0, quantity: 1 }]
  }
  return []
}

/** The request's own columns of a production ask, as stored (each only on its kind; the database refuses the rest). */
export function productionColumnsOf(ask: ProductionAsk): { readonly requestedDate: BusinessDate | null; readonly reasonCode: string | null; readonly reason: string | null; readonly sampleKind: AskSampleKind | null } {
  const rule = ASK_RULES[ask.kind]
  return {
    requestedDate: rule.date ? (ask.requestedDate ?? null) : null,
    reasonCode: rule.reasonCode !== 'NONE' && filled(ask.reasonCode) ? ask.reasonCode!.trim() : null,
    reason: filled(ask.note) ? ask.note!.trim() : null,
    sampleKind: rule.sampleKind && isAskSampleKind(ask.sampleKind) ? ask.sampleKind : null,
  }
}

// ---- after release: a change of a line in production (R-12) ---------------------------------------------------------------

/** How an accepted change is carried out. */
export const CHANGE_ACCEPT_WAYS = ['AMEND', 'CANCEL_AND_REMAKE', 'CLOSE_SHORT'] as const
export type ChangeAcceptWay = (typeof CHANGE_ACCEPT_WAYS)[number]

/** An order line and whether its work is released: a work order holding its cells is past DRAFT (cells change only in a DRAFT). */
export interface ReleaseLine {
  readonly id: string
  readonly seq: number
  readonly released: boolean
}

export interface ChangeAcceptOptions {
  /** The ways the office may accept it, the first offered first. */
  readonly ways: readonly ChangeAcceptWay[]
  /** The lines in production whose cells the change touches. */
  readonly releasedLineIds: readonly string[]
  readonly words: Words
  /** The pieces already made of those lines: a task for the floor lead (rework or scrap), never done by the accept itself. */
  readonly floorTask: Words | null
}

/** "The pieces already made are reworked or scrapped by the floor lead: a task is opened for them." */
export const FLOOR_TASK_WORDS: Words = Object.freeze({
  it: 'I capi già fatti li rilavora o li scarta il capo reparto: per loro si apre un compito.',
  en: 'The pieces already made are reworked or scrapped by the floor lead: a task is opened for them.',
})

/**
 * The ways a change may be accepted (plan §3: "After release, a size or quantity change can only be accepted as
 * cancel-and-remake or close-short. Rework and scrap become a task for the floor lead."). A change that touches no released
 * line's cells (or only the date and the address) is the amendment; one that changes the sizes, quantities or colourway of a
 * released line is cancel-and-remake, or close short when every size it touches there only goes down. A real change in
 * flight is Later.
 */
export function changeAcceptWays(cells: readonly (AskedCell & { readonly colourwayId?: string | null | undefined })[], lines: readonly ReleaseLine[]): ChangeAcceptOptions {
  const released = new Map(lines.filter((line) => line.released).map((line) => [line.id, line]))
  const touched = cells.filter((cell) => released.has(cell.orderLineId) && ((cell.size !== null && cell.quantity !== cell.quantityBefore) || (cell.colourwayId ?? null) !== null))
  if (touched.length === 0) {
    return { ways: ['AMEND'], releasedLineIds: [], words: { it: "Si accetta come modifica dell'ordine.", en: 'Accepted as an amendment of the order.' }, floorTask: null }
  }
  const releasedLineIds = [...new Set(touched.map((cell) => cell.orderLineId))]
  const seqs = releasedLineIds.map((id) => released.get(id)!.seq).sort((a, b) => a - b)
  const named = { it: seqs.length === 1 ? `La riga ${seqs[0]} è` : `Le righe ${seqs.join(', ')} sono`, en: seqs.length === 1 ? `Line ${seqs[0]} is` : `Lines ${seqs.join(', ')} are` }
  const downOnly = touched.every((cell) => (cell.colourwayId ?? null) === null && cell.size !== null && cell.quantity < cell.quantityBefore)
  return {
    ways: downOnly ? ['CLOSE_SHORT', 'CANCEL_AND_REMAKE'] : ['CANCEL_AND_REMAKE'],
    releasedLineIds,
    words: downOnly
      ? { it: `${named.it} già in produzione: si accetta solo chiudendo prima o annullando e rifacendo.`, en: `${named.en} in production already: accepted only by closing short, or by cancelling and remaking.` }
      : { it: `${named.it} già in produzione: si accetta solo annullando e rifacendo.`, en: `${named.en} in production already: accepted only by cancelling and remaking.` },
    floorTask: FLOOR_TASK_WORDS,
  }
}

/** The office's way of accepting a change, refused in words when the change's lines do not allow it. */
export function acceptWayProblems(way: ChangeAcceptWay, options: Pick<ChangeAcceptOptions, 'ways'>): Issue[] {
  if (options.ways.includes(way)) return []
  return [{ path: 'body/way', message: options.ways.includes('AMEND') ? 'This change touches no line in production: it is accepted as an amendment.' : 'After release, a size or quantity change is accepted only as cancel-and-remake or close short.' }]
}
