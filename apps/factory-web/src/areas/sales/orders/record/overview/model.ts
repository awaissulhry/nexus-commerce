import type { HealthInput, HealthState, PiecesColourway, PlainStage, StageStripInput, WaitingInput } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import { depositGate, type Phrase } from '../../model'
import { groupMadeToMeasure, unitsOf } from '../../mtm-groups'
import type { BrandHealth, BrandStage, Dates, Headline, OrderProduction, ProductionLine, Words } from './api'

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

/** Who acts next (office face): who the work waits on, since when, and what for (the first blocker's words). */
export function waitingInputOf(headline: Headline | null | undefined, locale: string): WaitingInput {
  if (!headline) return { who: undefined }
  const first = headline.waiting.blockers[0] ?? null
  return {
    who: headline.waiting.on,
    since: first?.since ?? headline.waiting.since,
    kind: first && (first.kind === 'APPROVAL' || first.kind === 'PARTNER_TASK' || first.kind === 'REQUEST') ? 'request' : 'record',
    what: first ? say(first.words, locale) : null,
  }
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

const figuresOf = (line: Pick<ProductionLine, LineColumn>): Record<LineColumn, Figure> => ({ ordered: line.ordered, cut: line.cut, sewn: line.sewn, checked: line.checked, packed: line.packed, shipped: line.shipped })

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

/** "Requests & changes" in counts: what waits on us, what waits on the customer, the latest change. */
export interface RequestCounts {
  readonly onUs: number
  readonly onUsSince: string | null
  readonly onCustomer: number
  readonly latest: { readonly revision: number; readonly at: string | null } | null
}

export function requestCountsOf(read: OrderProduction | null, order: Pick<Order, 'reapprovalNeededAt' | 'amendments'>): RequestCounts {
  const open = read?.changes?.openRequests ?? []
  const onUs = open.filter((request) => request.status === 'OPEN')
  const countered = open.filter((request) => request.status === 'COUNTERED').length
  return {
    onUs: onUs.length,
    onUsSince: onUs.map((request) => request.since).sort()[0] ?? null,
    onCustomer: countered + (order.reapprovalNeededAt ? 1 : 0),
    latest: order.amendments.latestRevision !== null ? { revision: order.amendments.latestRevision, at: order.amendments.latestAt } : null,
  }
}

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
}

/**
 * The order's linked records (industry idea 3; it replaces Lines' "Record chain"): Quote · Work orders · Shipments · Invoices · Deposit
 * · Complaints · Returns · Same quote. Counts are the rows the reader sees; work orders it does not reach are said apart ("1 work order
 * not shown"), never named; a list it may not read is held in words with no number.
 */
export function linkedRecordsOf(input: LinkedInput): { readonly records: readonly LinkedRecord[]; readonly workOrdersLeftOut: number } {
  const { order, prefix, can } = input
  const record = `${prefix}/sales/orders/${order.id}`
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
    { key: 'workOrders', count: workCount, words: null, href: workCount > 0 ? `${record}?tab=production` : null, held: null },
    { key: 'shipments', count: order.chain.shipments.length, words: null, href: order.chain.shipments.length > 0 ? `${record}?tab=shipments` : null, held: null },
    can.viewInvoices ? { key: 'invoices', count: order.chain.invoices.length, words: null, href: order.chain.invoices.length > 0 ? `${record}?tab=money#invoices` : null, held: null } : { key: 'invoices', count: null, words: null, href: null, held: phrase('overview.linked.invoicesHeld') },
    { key: 'deposit', count: null, words: phrase(`gate.state.${gate.state}`), href: `${record}?tab=money`, held: null },
    ...(input.complaints !== null ? [{ key: 'complaints' as const, count: input.complaints, words: null, href: input.complaints > 0 ? `${record}?tab=shipments` : null, held: null }] : []),
    ...(input.returns !== null ? [{ key: 'returns' as const, count: input.returns, words: null, href: input.returns > 0 ? `${record}?tab=shipments` : null, held: null }] : []),
    ...input.sameQuote.map((other) => ({ key: 'sameQuote' as const, count: null, words: phrase('overview.linked.sameQuoteValue', { number: other.number }), href: `${prefix}/sales/orders/${other.id}`, held: null })),
  ]
  return { records, workOrdersLeftOut: work?.workOrdersLeftOut ?? 0 }
}
// ── end F-SA-233
