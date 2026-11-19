import type { HealthInput, HealthState, PiecesColourway, PlainStage, StageStripInput } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import { depositGate, type Phrase } from '../../model'
import { groupMadeToMeasure, unitsOf } from '../../mtm-groups'
import type { BrandHealth, BrandStage, Dates, Headline, OrderProduction, ProductionLine, WaitingOn, Words } from './api'
// ---- F-OP-103: the ONE waiting list's inputs (the customer's requests as read, the order's open yes, Still to do) ----
import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { OpenApproval } from '../../api'
import { stillRowsOf, type StillRowOf } from '../changes/model'
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-104: the tab links keep the dock's scope (F-OP-210)
import { yesDoorOf } from '../../depth/model' // F-OP-117: the Changes dot
import { waitsForMe } from '../../../../home/approvals/requests/model' // F-OP-117

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview's rules, without
 * a screen: "Where it is now" (one sentence, who acts next, the ex-factory date and how it moved, the health, the customer's own
 * urgency, the five plain stages, what is in work as counts) and "Progress by line" (the order's OWN pieces per line: Ordered · Cut
 * and bundled · Sewn · Checked · Packed · Shipped; "Not counted here" where a site does not count a step, never 0), whose row opens the
 * line's sizes. Every figure is the production read's (B-SA-031: the order's own cells); nothing here names another customer, a
 * worker or a station. Words are `orders` keys (`overview.*`) and the production parts' own (`parts.*`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The API's own words in the page's language. */
export const say = (words: Words, locale: string): string => (locale === 'it' ? words.it : words.en)

/** The production read's stage is the parts' plain stage (the same five codes). */
export const plainStageOf = (stage: BrandStage): PlainStage => stage

/** The keeper's health → the parts' chip states. */
const HEALTH: Readonly<Record<BrandHealth, HealthState>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })

// ---- O1 "Where it is now" ------------------------------------------------------------------------------------------------------

/** The headline sentence: the plain stage (+ "1 line ahead"), or before / after production the commercial words. */
export type HeadlineWords = { readonly kind: 'stage'; readonly stage: PlainStage; readonly ahead: Phrase | null } | { readonly kind: 'phrase'; readonly phrase: Phrase } | { readonly kind: 'unknown' }

const BEFORE: readonly Order['status'][] = ['PENDING_APPROVAL', 'CONFIRMED']
const AFTER: readonly Order['status'][] = ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED']

export function headlineOf(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined): HeadlineWords {
  if (order.status === 'PENDING_APPROVAL') return { kind: 'phrase', phrase: phrase('status.PENDING_APPROVAL') }
  if (AFTER.includes(order.status)) {
    const shipped = order.chain.shipments.map((shipment) => shipment.shippedAt).filter((at): at is string => !!at).sort().at(-1) ?? null
    const delivered = order.chain.shipments.map((shipment) => shipment.deliveredAt).filter((at): at is string => !!at).sort().at(-1) ?? null
    if (order.status === 'CANCELLED') return { kind: 'phrase', phrase: phrase('status.CANCELLED') }
    if (order.status === 'CLOSED') return { kind: 'phrase', phrase: phrase('status.CLOSED') }
    if (shipped && delivered) return { kind: 'phrase', phrase: phrase('overview.headline.delivered', { shipped, delivered }) }
    if (shipped) return { kind: 'phrase', phrase: phrase('overview.headline.shipped', { shipped }) }
    return { kind: 'phrase', phrase: phrase(`status.${order.status}`) }
  }
  const stage = headline?.stage ?? null
  if (stage && !(BEFORE.includes(order.status) && stage.code === 'PREPARING')) {
    return { kind: 'stage', stage: plainStageOf(stage.code), ahead: stage.ahead > 0 ? phrase('overview.ahead', { count: stage.ahead }) : null }
  }
  if (order.status === 'CONFIRMED') {
    const gate = depositGate(order)
    return { kind: 'phrase', phrase: gate.state === 'WAITING' || gate.state === 'MISSING' ? phrase('overview.headline.waitingDeposit') : phrase('status.CONFIRMED') }
  }
  // In production with no stage read: "Stage not known yet" (the parts' words), never step 1.
  return { kind: 'unknown' }
}

/** The five plain stages for the StageStrip (office face): the stage now, its day, the working plan's days, blocked with why. */
export function stageStripOf(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined, dates: Dates | null | undefined, locale: string): StageStripInput & { readonly note?: string | null } {
  const stage = headline?.stage ?? null
  const planned = dates?.planned ?? null
  const expected: Partial<Record<PlainStage, string | null>> = { CUTTING: planned?.cutStart ?? null, SEWING: planned?.sewStart ?? null, QUALITY: planned?.finish ?? null }
  const blocked = headline?.held ? { why: headline.holds[0] ? say(headline.holds[0].words, locale) : null } : null
  if (!stage) {
    // Before any work order the order is preparing (never "step 1" by default once it is in work).
    if (order.status === 'CONFIRMED') return { stage: 'PREPARING', expected, blocked }
    return { stage: null }
  }
  return { stage: plainStageOf(stage.code), reached: stage.since ? { [stage.code]: stage.since } : {}, expected, sewingCounted: !stage.sewingNotCounted, blocked }
}

/** Why the StageStrip waits at Preparing: work orders are made after the deposit. */
export function preparingNote(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined): Phrase | null {
  if (order.status !== 'CONFIRMED' || headline?.stage) return null
  const gate = depositGate(order)
  return gate.state === 'WAITING' || gate.state === 'MISSING' ? phrase('overview.afterDeposit') : null
}

/** "Bundles in work: 3 at Sewing" — counts only (the order's ACTIVE bundles), never a name or a station; none: nothing said. */
export function inWorkOf(headline: Headline | null | undefined): { readonly count: number; readonly stage: PlainStage } | null {
  const stage = headline?.stage ?? null
  if (!headline || !stage || headline.inWork.bundles <= 0) return null
  return { count: headline.inWork.bundles, stage: plainStageOf(stage.code) }
}

/** The ex-factory line: the promise and how it moved ("moved 2× · +6 d since first promised"); null without a promise. */
export function exFactoryOf(order: Pick<Order, 'promiseDate'>, headline: Headline | null | undefined): Phrase | null {
  const date = headline?.promise.date ?? order.promiseDate
  if (!date) return null
  const moves = headline?.promise.moves ?? 0
  const slip = headline?.promise.slipDays ?? null
  if (moves > 0 && slip !== null && slip !== 0) return phrase('overview.exFactoryMoved', { date, count: moves, days: slip > 0 ? `+${slip}` : String(slip) })
  if (moves > 0) return phrase('overview.exFactoryMovedOnly', { date, count: moves })
  return phrase('overview.exFactory', { date })
}

/**
 * The health chip's input: the keeper's health and a person's raise (its note only for the office, workorders.view); no state kept
 * yet: the order read's own lateness in the same words ("Late · 3 d"), else not known.
 */
export function healthInputOf(order: Pick<Order, 'daysLate' | 'promiseDate' | 'status'>, headline: Headline | null | undefined, dates?: Dates | null): HealthInput {
  const health = headline?.health ?? null
  const daysLate = order.daysLate !== null && order.daysLate > 0 && !AFTER.includes(order.status) ? order.daysLate : null
  if (!health) return { computed: daysLate !== null ? 'LATE' : undefined, daysLate, promise: order.promiseDate, plan: dates?.planned.finish ?? null }
  const raise = health.raise
  return {
    computed: HEALTH[health.computed ?? health.code],
    daysLate,
    raised: raise ? { reason: raise.reasonCode as NonNullable<HealthInput['raised']>['reason'], note: raise.note, by: raise.by?.name ?? null, at: raise.at } : null,
    promise: order.promiseDate,
    plan: dates?.planned.finish ?? null,
  }
}

/** The band draws the chip only when it matters: Late or At risk (never "On track", never "No date yet"). */
export function bandHealthOf(input: HealthInput): boolean {
  return input.computed === 'LATE' || input.computed === 'AT_RISK' || !!input.raised
}

/**
 * F-OP-103: who acts next (office face) is the first row of the ONE waiting list (`waitingOf`), so its "since" is the card's and the
 * band's; with no row, who the read says the work waits on. The view says the row's words (`rowWordsOf`).
 */
// F-OP-301 (walk #2): with no row it never falls back to the kept `headline.waiting` (a stale "Waiting on us · 5 d" beside a card
// that says nothing waits): the oldest Still to do row (the card's third list) names who acts, else nobody (`who: null`, the view
// says the card's own "Nothing waits"); no headline read: not known.
export interface WhoActsNext {
  readonly who: WaitingOn | null | undefined
  readonly since: string | null
  readonly kind: 'request' | 'record'
  readonly row: WaitingRow | null
  /** F-OP-301: the Still to do row it names when no waiting row stands (its words are the view's `what`). */
  readonly still: StillRowOf | null
}

export function whoActsNextOf(rows: readonly WaitingRow[], headline: Headline | null | undefined, still: readonly StillRowOf[] = []): WhoActsNext {
  const first = rows[0] ?? null
  if (first) return { who: first.on, since: first.since, kind: REQUEST_KINDS.has(first.kind) ? 'request' : 'record', row: first, still: null }
  if (!headline) return { who: undefined, since: null, kind: 'record', row: null, still: null }
  const oldest = [...still].sort((a, b) => a.since.localeCompare(b.since))[0] ?? null
  if (oldest) return { who: oldest.waitingOn === 'CUSTOMER' ? 'BRAND' : 'US', since: oldest.since, kind: 'record', row: null, still: oldest }
  return { who: null, since: null, kind: 'record', row: null, still: null }
}

// ---- O2 "Progress by line" -----------------------------------------------------------------------------------------------------

/** The columns, in their order (the shared catalogue's words: `parts.pieces.stages.*`, + Shipped). */
export const LINE_COLUMNS = ['ordered', 'cut', 'sewn', 'checked', 'packed', 'shipped'] as const
export type LineColumn = (typeof LINE_COLUMNS)[number]

/** A figure: a count, or "not counted here" (null: the site does not count that step — never 0). */
export type Figure = number | null

export interface LineRow {
  /** The row's key: the line's id, or the made-to-measure group's. */
  readonly id: string
  /** The line ids the row stands for (a made-to-measure group: one per unit). */
  readonly lineIds: readonly string[]
  readonly seq: number
  readonly style: { readonly code: string; readonly name: string } | null
  readonly colourway: { readonly code: string; readonly name: string } | null
  /** The style id and colourway id (the line's picture). */
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly mtm: { readonly units: number } | null
  readonly figures: Readonly<Record<LineColumn, Figure>>
  /** Where the line is: its plain stage from its own counts; null: not in work orders yet. */
  readonly stage: PlainStage | null
  readonly notInWorkOrders: boolean
  /** Office only: pieces cut beyond what the line now wants (a change lowered it after cutting). */
  readonly madeExtra: number
}

const sumOf = (values: readonly Figure[]): Figure => (values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0))

/** A line's plain stage from its own counts: the first step not done (a step not counted is passed over); nothing cut: Preparing. */
export function lineStageOf(figures: Readonly<Record<LineColumn, Figure>>): PlainStage {
  const ordered = figures.ordered ?? 0
  if (ordered <= 0) return 'PREPARING'
  if ((figures.cut ?? 0) === 0 && figures.cut !== null) return 'PREPARING'
  const steps: readonly [LineColumn, PlainStage][] = [
    ['cut', 'CUTTING'],
    ['sewn', 'SEWING'],
    ['checked', 'QUALITY'],
    ['packed', 'READY'],
  ]
  for (const [column, stage] of steps) {
    const value = figures[column]
    if (value !== null && value < ordered) return stage
  }
  return 'READY'
}

/**
 * The rows of "Progress by line": one per colour line in the order's own figures; the made-to-measure units of one style × colourway
 * are ONE row (R9). Fees are left out (no pieces). The order read's lines give the ids of the style and colourway (the picture).
 */
export function lineRowsOf(lines: readonly ProductionLine[], order: Pick<Order, 'lines'>): LineRow[] {
  const ofOrder = new Map(order.lines.map((line) => [line.id, line]))
  const goods = [...lines].filter((line) => line.kind !== 'FEE').sort((a, b) => a.seq - b.seq)
  return groupMadeToMeasure(goods, (line) => line.lineId).map((entry) => {
    const members = entry.kind === 'line' ? [entry.line] : [...entry.lines]
    const first = members[0]!
    const figures = Object.fromEntries(LINE_COLUMNS.map((column) => [column, column === 'ordered' || column === 'shipped' ? members.reduce((sum, line) => sum + line[column], 0) : sumOf(members.map((line) => line[column]))])) as Record<LineColumn, Figure>
    const notInWorkOrders = members.every((line) => line.notInWorkOrders)
    const source = ofOrder.get(first.lineId)
    return {
      id: entry.key,
      lineIds: members.map((line) => line.lineId),
      seq: first.seq,
      style: first.style,
      colourway: first.colourway,
      styleId: source?.styleId ?? null,
      colourwayId: source?.colourwayId ?? null,
      mtm: entry.kind === 'mtm' ? { units: unitsOf(members) } : null,
      figures,
      stage: notInWorkOrders ? null : lineStageOf(figures),
      notInWorkOrders,
      madeExtra: members.reduce((sum, line) => sum + line.madeExtra, 0),
    }
  })
}

/** The total row: each column summed over the rows (null when no row counts it). */
export function totalOf(rows: readonly LineRow[]): Record<LineColumn, Figure> {
  return Object.fromEntries(LINE_COLUMNS.map((column) => [column, sumOf(rows.map((row) => row.figures[column]))])) as Record<LineColumn, Figure>
}

/** Nothing of the order is cut yet (counted and zero, or not counted at all): "Nothing cut yet". */
export const nothingCutYet = (rows: readonly LineRow[]): boolean => rows.length > 0 && rows.every((row) => (row.figures.cut ?? 0) === 0)

// ---- the line's sizes (a centred window; J / K walk the lines) -----------------------------------------------------------------

export interface LineSizes {
  /** The PiecesGrid's colourway (the order's own cells per size): Ordered · Cut and bundled · Sewn · Checked · Packed. */
  readonly colourway: PiecesColourway
  /** Per size: shipped, the finish forecast (planning.promise.view; null without it), cut beyond what the size wants. */
  readonly sizes: readonly { readonly size: string; readonly shipped: number; readonly finish: string | null; readonly madeExtra: number }[]
  /** A made-to-measure group: its units, no size grid. */
  readonly units: number | null
}

/** A row's sizes for the window (its first line's; a made-to-measure group lists its units instead). */
export function lineSizesOf(row: LineRow, lines: readonly ProductionLine[], dates: Dates | null | undefined, label: string): LineSizes {
  const members = lines.filter((line) => row.lineIds.includes(line.lineId))
  const forecast = dates?.forecast ?? null
  if (row.mtm) return { colourway: { id: row.id, label, sizes: [] }, sizes: [], units: row.mtm.units }
  const line = members[0]
  const finishOf = (size: string | null) => forecast?.find((entry) => entry.lineId === line?.lineId)?.sizes.find((entry) => entry.size === size)?.finish ?? null
  const sizes = (line?.sizes ?? []).map((size) => ({ size: size.size ?? '—', ordered: size.ordered, cut: size.cut, sewn: size.sewn, inspected: size.checked, packed: size.packed }))
  return {
    colourway: { id: row.id, label, sizes },
    sizes: (line?.sizes ?? []).map((size) => ({ size: size.size ?? '—', shipped: size.shipped, finish: finishOf(size.size), madeExtra: size.madeExtra })),
    units: null,
  }
}

/** J / K: the next or the previous row (it wraps). */
export function walkOf(rows: readonly LineRow[], current: string | null, step: 1 | -1): string | null {
  if (rows.length === 0) return null
  const at = rows.findIndex((row) => row.id === current)
  if (at === -1) return rows[0]!.id
  return rows[(at + step + rows.length) % rows.length]!.id
}

// ---- the read's state (loading, failed, withheld) ------------------------------------------------------------------------------

/** The order's production read on the page: still read, read (with its time), or failed (only this part says so). */
export type ProductionState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly read: OrderProduction } | { readonly status: 'failed'; readonly problem: string }

/** The read once it is there. */
export const readOf = (state: ProductionState | null | undefined): OrderProduction | null => (state?.status === 'ready' ? state.read : null)

/**
 * A re-read of some parts put into the read the page holds: the parts read again replace theirs (and their withheld keys); the rest
 * stay as they were. The time is the newest read's.
 */
export function mergeRead(known: OrderProduction | null, next: OrderProduction): OrderProduction {
  if (!known) return next
  const reread = new Set(next.parts)
  const keep = known.withheld.filter((key) => !reread.has(key.split('.')[0] as never))
  return {
    ...known,
    ...Object.fromEntries(next.parts.map((part) => [part, next[part]])),
    order: next.order,
    asOf: next.asOf,
    refreshSeconds: next.refreshSeconds,
    parts: [...new Set([...known.parts, ...next.parts])],
    withheld: [...new Set([...keep, ...next.withheld])],
  }
}

// ── F-SA-233 (sales page plan N2, picks P2, P3, P16; 10-order-page §2.1 O3–O8; review C-20) ──────────────────────────────────────

/** Where the order is made, as places only (a site · a line · a team by name, or an outside workshop) — never an operator. */
export function placeWords(place: NonNullable<OrderProduction['people']>['places'][number]): string {
  if (place.workshop) return place.workshop.name
  return [place.site?.name ?? place.site?.code, place.line?.name ?? place.line?.code, place.team?.name ?? place.team?.code].filter((part): part is string => !!part).join(' · ')
}

/** F-OP-104: the requested date's field on Lines in edit mode (its id: Next dates' "Change…" focuses it). */
export const REQUESTED_FIELD_ID = 'amend-requested-date'

/** One of the next dates (the order's own milestones, late first; the ex-factory day when fewer than three wait). */
export interface NextDate {
  readonly id: string
  readonly what: { readonly kind: 'gate'; readonly gateKind: string | null; readonly label: string | null } | { readonly kind: 'milestone'; readonly milestone: string } | { readonly kind: 'exFactory' }
  readonly target: string | null
  readonly late: number | null
}

/** The next three dates to come: late first (most late first), then by target; the ex-factory day fills the last place. */
export function nextDatesOf(dates: Dates | null | undefined, promise: string | null, count = 3): NextDate[] {
  const open = (dates?.milestones ?? []).filter((row) => row.state !== 'DONE')
  const sorted = [...open].sort((a, b) => Number((b.late ?? 0) > 0) - Number((a.late ?? 0) > 0) || (b.late ?? 0) - (a.late ?? 0) || (a.target ?? '9999').localeCompare(b.target ?? '9999'))
  const rows: NextDate[] = sorted.slice(0, count).map((row) => ({ id: row.id, what: row.kind === 'GATE' ? { kind: 'gate', gateKind: row.gateKind, label: row.label } : { kind: 'milestone', milestone: row.kind }, target: row.target, late: row.late }))
  if (rows.length < count && promise && !open.some((row) => row.kind === 'SHIP')) rows.push({ id: 'ex-factory', what: { kind: 'exFactory' }, target: promise, late: null })
  return rows
}

// ---- F-OP-103 (order page plan N1; 10-order-page §3.2; 13-backend B4; review R-21, R-22): the ONE waiting list ----------------------
/**
 * The order's waiting list, ONE source for Overview's "Who acts next", the "Requests & changes" card and the Changes badge (R-22; the
 * dock does not read it, R-21): each blocker of the production read (`headline.waiting.blockers[]`, its `ref` and `sub`) and each open
 * yes of the order (the order read's `openApprovals`, B-OP-020) is ONE row — who it waits on, since when, its words, and ONE door:
 *
 *   BRAND_REQUEST · REQUEST / COUNTER     Answer… (the ONE review window on this page, `?open=`) — an agreed or lapsed counter waits on us
 *   BRAND_REQUEST · PROBLEM               Reply in the thread (This order's conversation at the message it was raised with)
 *   BRAND_REQUEST · REPROMISE             Production › #dates (Decide… is F-OP-105: deferred)
 *   an open yes of the order              Confirm / Refuse… for an approver who did not ask; held for the asker; who decides (F-OP-101)
 *   APPROVAL · PARTNER_TASK               Changes › (what we asked the customer: it decides)
 *   DEPOSIT                               Record the payment (payments.record, the request open) or Money ›
 *   BRAND_PAUSE                           Lift the customer's pause… in place (F-OP-116: the shared Lift; no ref: Production › #holds)
 *   holds · quality · work                Production › #holds
 *   MATERIAL_SHORT · GATE                 Production › #dates
 *
 * Oldest first (a row with no known start last). Nothing here names another customer: every row is this order's own read.
 */
export type WaitingDoor =
  | { readonly kind: 'answer'; readonly requestId: string; readonly request: BrandRequest | null }
  | { readonly kind: 'reply'; readonly messageId: string | null }
  | { readonly kind: 'yes'; readonly task: OpenApproval }
  | { readonly kind: 'payment'; readonly requestId: string }
  | { readonly kind: 'tab'; readonly tab: 'production' | 'money' | 'changes'; readonly anchor: string | null }
  /** F-OP-116: the customer's pause on a work order this reader reaches: "Lift the customer's pause…" (the shared Lift, F-OP-114). */
  | { readonly kind: 'lift'; readonly workOrderId: string }

/** A row's words: the API's own (it + en), or the page's phrase (its `{customer}` and the request's kind as `{what}` filled in: rowWordsOf). */
export type WaitingWords = { readonly kind: 'api'; readonly words: Words } | { readonly kind: 'phrase'; readonly phrase: Phrase; readonly requestKind?: string | null }

export interface WaitingRow {
  readonly key: string
  /** The blocker's kind, or YES for an open yes of the order. */
  readonly kind: string
  readonly sub: string | null
  /** F-OP-301 (walk #1): the record it is about (the Changes tab names an approval we asked by its own question); null: none. */
  readonly ref: { readonly type: string; readonly id: string } | null
  readonly on: WaitingOn
  readonly since: string | null
  readonly words: WaitingWords
  readonly door: WaitingDoor
}

/** The kinds that wait for an answer of a person (a request, a yes, a task) — the rest wait for a record (a payment, a hold …). */
const REQUEST_KINDS: ReadonlySet<string> = new Set(['APPROVAL', 'PARTNER_TASK', 'BRAND_REQUEST', 'YES'])
const HOLD_KINDS: ReadonlySet<string> = new Set(['BRAND_PAUSE', 'QUALITY_HOLD', 'NO_MOVE', 'NONCONFORMANCE', 'RELEASE_CHECK', 'SUBCONTRACT', 'CUSTOMER_MATERIAL'])
const DATE_KINDS: ReadonlySet<string> = new Set(['MATERIAL_SHORT', 'GATE'])

interface WaitingInputs {
  /** The customer's requests of this order as read (the review window's door needs the request); null: not read. */
  readonly requests: readonly BrandRequest[] | null | undefined
  /** The order's open requests for a yes (the order read's, B-OP-020). */
  readonly approvals: readonly OpenApproval[] | null | undefined
  /** May record a payment (payments.record). */
  readonly recordPayment: boolean
  /** The page's language (an open yes names its kind in it). */
  readonly locale: string
}

type Blocker = Headline['waiting']['blockers'][number]

function doorOf(blocker: Blocker, inputs: WaitingInputs): WaitingDoor {
  const ref = blocker.ref ?? null
  if (blocker.kind === 'BRAND_REQUEST') {
    if ((blocker.sub === 'REQUEST' || blocker.sub === 'COUNTER') && ref) return { kind: 'answer', requestId: ref.id, request: (inputs.requests ?? []).find((request) => request.id === ref.id) ?? null }
    if (blocker.sub === 'PROBLEM') return { kind: 'reply', messageId: ref?.messageId ?? null }
    return { kind: 'tab', tab: 'production', anchor: 'dates' }
  }
  if (blocker.kind === 'DEPOSIT') return inputs.recordPayment && ref?.type === 'DepositRequest' ? { kind: 'payment', requestId: ref.id } : { kind: 'tab', tab: 'money', anchor: null }
  if (blocker.kind === 'APPROVAL' || blocker.kind === 'PARTNER_TASK') return { kind: 'tab', tab: 'changes', anchor: null }
  // F-OP-116: the customer's pause is lifted in place (a work order the reader does not reach has no ref: Production › holds).
  if (blocker.kind === 'BRAND_PAUSE' && ref?.type === 'WorkOrder') return { kind: 'lift', workOrderId: ref.id }
  if (DATE_KINDS.has(blocker.kind)) return { kind: 'tab', tab: 'production', anchor: 'dates' }
  return { kind: 'tab', tab: 'production', anchor: HOLD_KINDS.has(blocker.kind) ? 'holds' : null }
}

function wordsOf(blocker: Blocker, inputs: WaitingInputs): WaitingWords {
  const api: WaitingWords = { kind: 'api', words: blocker.words }
  if (blocker.kind !== 'BRAND_REQUEST') return api
  const request = blocker.ref ? ((inputs.requests ?? []).find((entry) => entry.id === blocker.ref!.id) ?? null) : null
  // "<Customer> asks: <kind>" — the band notice's own words (band.asks).
  if (blocker.sub === 'REQUEST') return request ? { kind: 'phrase', phrase: phrase('band.asks'), requestKind: request.kind } : api
  if (blocker.sub === 'COUNTER') return request?.counter?.state === 'AGREED' ? { kind: 'phrase', phrase: phrase('waiting.counterAgreed') } : request?.counter?.state === 'LAPSED' ? { kind: 'phrase', phrase: phrase('waiting.counterLapsed') } : api
  if (blocker.sub === 'PROBLEM') return { kind: 'phrase', phrase: phrase('waiting.problem') }
  if (blocker.sub === 'REPROMISE') return { kind: 'phrase', phrase: phrase('waiting.repromise') }
  return api
}

const byOldest = (a: WaitingRow, b: WaitingRow): number => (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0) || (a.since ?? '').localeCompare(b.since ?? '')

export function waitingOf(read: Pick<OrderProduction, 'headline'> | null | undefined, inputs: WaitingInputs): WaitingRow[] {
  const blockers = read?.headline?.waiting.blockers ?? []
  const rows: WaitingRow[] = blockers.map((blocker, index) => ({
    key: `${blocker.kind}:${blocker.ref?.type ?? '-'}:${blocker.ref?.id ?? index}`,
    kind: blocker.kind,
    sub: blocker.sub ?? null,
    ref: blocker.ref ? { type: blocker.ref.type, id: blocker.ref.id } : null, // F-OP-301
    on: blocker.on,
    since: blocker.since,
    words: wordsOf(blocker, inputs),
    door: doorOf(blocker, inputs),
  }))
  // An open yes of the order waits on us (an office person decides it): its own row with the yes in place.
  for (const task of inputs.approvals ?? []) {
    rows.push({ key: `YES:${task.taskId}`, kind: 'YES', sub: null, ref: null, on: 'US', since: task.requestedAt, words: { kind: 'phrase', phrase: phrase('waiting.yes', { kind: inputs.locale === 'en' ? task.kindLabel.en : task.kindLabel.it }) }, door: { kind: 'yes', task } })
  }
  // Rows of the same start keep the read's order.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => byOldest(a.row, b.row) || a.index - b.index).map((entry) => entry.row)
}

/** A row's words in the page's language: the API's own, or the phrase with the customer's name and the request's kind in words. */
export function rowWordsOf(row: Pick<WaitingRow, 'words'>, say: { readonly t: (key: string, params?: Record<string, string | number>) => string; readonly kindWords: (kind: string) => string; readonly locale: string; readonly customer: string }): string {
  if (row.words.kind === 'api') return row.words.words[say.locale === 'en' ? 'en' : 'it']
  const { phrase: words, requestKind } = row.words
  return say.t(words.key, { ...(words.params ?? {}), customer: say.customer, ...(requestKind ? { what: say.kindWords(requestKind) } : {}) })
}

/** "Requests & changes": Waiting on us N · Waiting on <Customer> N · Still to do N (top 3) · the latest change; "Nothing waits" only when all three are empty. */
export interface WaitingCard {
  readonly onUs: readonly WaitingRow[]
  readonly onCustomer: readonly WaitingRow[]
  readonly still: readonly StillRowOf[]
  readonly latest: { readonly revision: number; readonly at: string | null } | null
  readonly nothing: boolean
}

export function waitingCardOf(rows: readonly WaitingRow[], read: OrderProduction | null | undefined, order: Pick<Order, 'amendments'>): WaitingCard {
  const onUs = rows.filter((row) => row.on === 'US')
  const onCustomer = rows.filter((row) => row.on === 'BRAND')
  const still = stillRowsOf(read)
  return {
    onUs,
    onCustomer,
    still,
    latest: order.amendments.latestRevision !== null ? { revision: order.amendments.latestRevision, at: order.amendments.latestAt } : null,
    nothing: onUs.length === 0 && onCustomer.length === 0 && still.length === 0,
  }
}

/** R-22: the Changes tab's badge counts the card's own rows (waiting on us, on the customer, still to do) — never a second rule. */
export const changesBadgeOf = (card: Pick<WaitingCard, 'onUs' | 'onCustomer' | 'still'>): number => card.onUs.length + card.onCustomer.length + card.still.length

/**
 * F-OP-117 (10-order-page §6): the Changes tab's dot — one of the card's rows waits on THIS reader: a yes they decide, a request
 * their team answers, a Still to do row that is their turn.
 */
export function changesDotOf(card: Pick<WaitingCard, 'onUs' | 'still'>): boolean {
  if (card.still.some((row) => row.mayAct)) return true
  return card.onUs.some((row) => (row.door.kind === 'yes' && yesDoorOf(row.door.task).kind === 'decide') || (row.door.kind === 'answer' && !!row.door.request && waitsForMe(row.door.request)))
}
// ---- end F-OP-103

// ---- F-OP-301 (walk #1, #2, #3; plan N1 "Waiting": the header, the card and the Changes badge use the same list) -----------------
/**
 * The ONE call every reader of the waiting list makes — Overview's "Who acts next" and "Requests & changes", the Changes badge and
 * dot, and the Changes tab's "Waiting on us" / "Waiting on the customer" — so they cannot disagree (the walk saw badge 4, Overview
 * 3 + 1, Changes 1 and "Nothing waits on the customer" on one order). While the production read is not in, nothing is claimed
 * (`loading`: never "Nothing waits" before it); a failed read says so. No production read on the page at all (a design case): the
 * order's own open yes only.
 */
export type WaitingState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly rows: readonly WaitingRow[]; readonly card: WaitingCard; readonly next: WhoActsNext }

interface WaitingPage {
  readonly production?: ProductionState | null
  readonly requests?: { readonly value: readonly BrandRequest[] | null } | null
  readonly can: { readonly recordPayment: boolean }
}

export function orderWaitingOf(order: Pick<Order, 'openApprovals' | 'amendments'>, page: WaitingPage, locale: string): WaitingState {
  const state = page.production ?? null
  if (state?.status === 'loading') return { status: 'loading' }
  if (state?.status === 'failed') return { status: 'failed', problem: state.problem }
  const read = readOf(state)
  const rows = waitingOf(read, { requests: page.requests?.value ?? null, approvals: order.openApprovals, recordPayment: page.can.recordPayment, locale })
  const card = waitingCardOf(rows, read, order)
  return { status: 'ready', rows, card, next: whoActsNextOf(rows, read?.headline ?? null, card.still) }
}
// ---- end F-OP-301

/** One linked record, a count button that is a real link — or, without its right, held in words with no number. */
export interface LinkedRecord {
  readonly key: 'quote' | 'workOrders' | 'shipments' | 'invoices' | 'deposit' | 'complaints' | 'returns' | 'sameQuote'
  /** A count (0 is an answer); null: the entry says words instead (the quote, the deposit's state). */
  readonly count: number | null
  readonly words: Phrase | null
  /** Where it opens; null: no door (a held entry, a quote the reader may not open). */
  readonly href: string | null
  /** Held: it needs a right the reader does not hold (said, never counted). */
  readonly held: Phrase | null
}

interface LinkedInput {
  readonly order: Pick<Order, 'id' | 'chain' | 'depositRequired'>
  readonly prefix: string
  readonly can: { readonly viewQuotes: boolean; readonly viewInvoices: boolean }
  /** The production read's work part (the work orders this reader reaches, the others counted); null: not read or withheld. */
  readonly work: OrderProduction['work'] | null | undefined
  readonly complaints: number | null
  readonly returns: number | null
  readonly sameQuote: readonly { readonly id: string; readonly number: string }[]
  /** B-TH-228: the request an order was made from straight (no quote between); undefined: still read (nothing claimed). */
  readonly madeFrom?: { readonly id: string; readonly number: string } | null
  /** F-OP-104: the page's address terms now (a tab link keeps the dock's scope, tabHref); absent: none. */
  readonly search?: string
}

/**
 * The order's linked records (industry idea 3; it replaces Lines' "Record chain"): Quote · Work orders · Shipments · Invoices · Deposit
 * · Complaints · Returns · Same quote. Counts are the rows the reader sees; work orders it does not reach are said apart ("1 work order
 * not shown"), never named; a list it may not read is held in words with no number.
 */
export function linkedRecordsOf(input: LinkedInput): { readonly records: readonly LinkedRecord[]; readonly workOrdersLeftOut: number } {
  const { order, prefix, can } = input
  const record = `${prefix}/sales/orders/${order.id}`
  // F-OP-104 (F-OP-210, R-19): the order's own tabs through tabHref — the dock's scope kept.
  const tab = (name: string, anchor?: string) => `${tabHref(record, name, input.search ?? '')}${anchor ? `#${anchor}` : ''}`
  const quote = order.chain.quote
  const work = input.work ?? null
  const workCount = work ? work.workOrders.length + work.mtm.reduce((sum, group) => sum + group.workOrders, 0) : order.chain.workOrders.length
  const gate = depositGate(order)
  const records: LinkedRecord[] = [
    ...(quote
      ? [{ key: 'quote' as const, count: null, words: phrase('chain.quoteValue', { number: quote.number, revision: quote.revision }), href: can.viewQuotes ? `${prefix}/sales/quotes/${quote.id}` : null, held: null }]
      : input.madeFrom
        ? [{ key: 'quote' as const, count: null, words: phrase('chain.fromRequest', { number: input.madeFrom.number }), href: `${prefix}/sales/incoming/${encodeURIComponent(input.madeFrom.id)}`, held: null }]
        : input.madeFrom === null
          ? [{ key: 'quote' as const, count: null, words: phrase('chain.noQuote'), href: null, held: null }]
          : []),
    { key: 'workOrders', count: workCount, words: null, href: workCount > 0 ? tab('production') : null, held: null },
    { key: 'shipments', count: order.chain.shipments.length, words: null, href: order.chain.shipments.length > 0 ? tab('shipments') : null, held: null },
    // F-OP-306 (walk #21): without invoices.view no number and the Money tab's own sentence (one rule, one wording for both).
    can.viewInvoices ? { key: 'invoices', count: order.chain.invoices.length, words: null, href: order.chain.invoices.length > 0 ? tab('money', 'invoices') : null, held: null } : { key: 'invoices', count: null, words: null, href: null, held: phrase('money.noInvoiceRight') },
    { key: 'deposit', count: null, words: phrase(`gate.state.${gate.state}`), href: tab('money'), held: null },
    ...(input.complaints !== null ? [{ key: 'complaints' as const, count: input.complaints, words: null, href: input.complaints > 0 ? tab('shipments') : null, held: null }] : []),
    ...(input.returns !== null ? [{ key: 'returns' as const, count: input.returns, words: null, href: input.returns > 0 ? tab('shipments') : null, held: null }] : []),
    ...input.sameQuote.map((other) => ({ key: 'sameQuote' as const, count: null, words: phrase('overview.linked.sameQuoteValue', { number: other.number }), href: `${prefix}/sales/orders/${other.id}`, held: null })),
  ]
  return { records, workOrdersLeftOut: work?.workOrdersLeftOut ?? 0 }
}
// ── end F-SA-233
