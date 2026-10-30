import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { PartyTaxMode } from '../../parties/tax'
import { canTransition, defineMachine, isState } from '../../state/machine'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import type { PriceBasis } from '../../tax/vat-summary'
import { priceBasisOf, type SalesLineKind } from '../quotes/quotes'

/**
 * A sales order's life (B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206, SAL-214; plan A1 §2.5 "Sales order", PLAN §4.7
 * "Closing the order"), pure. apps/factory-api's modules/sales/orders moves it, one command per move, and the
 * …_sales_guards trigger holds the frame for every login (CLOSED only from SHIPPED, CANCELLED with its reason only before
 * anything shipped, closedAt exactly when CLOSED or CANCELLED, originalPromiseDate set once).
 *
 *   CONFIRMED → IN_PRODUCTION → READY → PARTLY_SHIPPED → SHIPPED → CLOSED; CANCELLED (with a reason) before anything shipped.
 *
 * One writer per move (SAL-204; the design's board: cards never drag, each state changes only through its own action):
 *
 *   IN_PRODUCTION    the system, when the first work order of its lines is released (workorder.released)
 *   READY            the system, when quality has released every ordered piece; by hand with a reason (orders.manage)
 *                    while quality release is not in use
 *   PARTLY_SHIPPED   the system, from the shipped quantities (shipment.status_changed): part of the order left
 *   SHIPPED          the system, from the shipped quantities: every ordered piece left (a returned shipment brings a
 *                    SHIPPED order back to PARTLY_SHIPPED)
 *   CLOSED           the close command: settled (every line shipped, invoiced and paid: the money module's port, its
 *                    order.fully_settled event) by the system or a person; not settled only with a reason, by a person
 *                    with orders.close
 *   CANCELLED        by a person, with a reason, while CONFIRMED, IN_PRODUCTION or READY (B-W2a-30, SAL-211: the cancel
 *                    impact check, ./daily `cancelImpact`): nothing shipped, no draft work order left on its lines, no
 *                    shipment being packed and no invoice of it; released work orders, cut leather, reservations,
 *                    purchase orders and a paid deposit are left behind and named
 *
 * W2a (B-W2a-30): a line closed short (SAL-210) counts as done in the progress: the pieces that will not be made or
 * shipped are `closedShort`, never "to ship".
 */

export const SALES_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED'] as const
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number]

export const STATUS_WORDS: Readonly<Record<SalesOrderStatus, string>> = Object.freeze({
  CONFIRMED: 'Confirmed',
  IN_PRODUCTION: 'In production',
  READY: 'Ready',
  PARTLY_SHIPPED: 'Partly shipped',
  SHIPPED: 'Shipped',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
})

/** The board's lanes (SAL-214): the open states, then shipped; closed and cancelled are counted beside them. */
export const BOARD_LANES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'] as const satisfies readonly SalesOrderStatus[]

/** Not shipped yet: a promise date in the past makes them late. */
export const OPEN_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])

/** Its lines (and their own dates) change only in these states (the …_sales_guards trigger: nothing shipped yet). */
export const LINE_CHANGE_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION', 'READY'])

/** Final: nothing on the order changes any more. */
export const FINAL_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CLOSED', 'CANCELLED'])

/** B-W2a-30 (SAL-211): an order is cancelled only before anything shipped (the …_sales_guards trigger says so too). */
export const CANCEL_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION', 'READY'])

export const isSalesOrderStatus = (value: unknown): value is SalesOrderStatus => isState(salesOrderMachine, value)

/** How much of the order left, from the shipped quantities. */
export type ShippedState = 'NONE' | 'PARTLY' | 'ALL'

/** The money module's answer to "is every line shipped, invoiced and paid?" (the close command's port). */
export interface SettlementAnswer {
  readonly settled: boolean
  /** What is missing, in words (empty when settled). */
  readonly missing: readonly { readonly code: string; readonly message: string }[]
  /** Where the answer comes from: the settle events, or the money module's own computation. */
  readonly source: string
}

/** What a move's guard reads. */
export interface SalesOrderFacts {
  /** Work orders of its lines ever released (released, in progress, completed, closed, or cancelled after it). */
  readonly releasedWorkOrders?: number
  /** The numbers of the work orders of its lines that are still drafts. */
  readonly draftWorkOrders?: readonly string[]
  /** How much of the order left (shipments SHIPPED or DELIVERED). */
  readonly shipped?: ShippedState
  /** Quality released every ordered piece (releases less their reversals). */
  readonly released?: boolean
  /** Is it settled? (CLOSED) */
  readonly settlement?: SettlementAnswer
  /** The reason a person gave: a cancellation, a ready by hand, a close while not settled. */
  readonly reason?: string | null
  /**
   * B-W2a-30: what stops a cancellation besides the reason and the drafts, in words (./daily `cancelImpact` blocks: a
   * shipment being packed, an invoice of the order).
   */
  readonly cancelBlocks?: readonly string[]
}

const hasReason = (facts: SalesOrderFacts): boolean => typeof facts.reason === 'string' && facts.reason.trim() !== ''

const missingWords = (settlement: SettlementAnswer | undefined): string =>
  settlement && settlement.missing.length > 0 ? settlement.missing.map((entry) => entry.message).join(' ') : 'nothing says so yet'

export const salesOrderMachine = defineMachine<SalesOrderStatus, SalesOrderFacts>({
  name: 'sales order',
  states: SALES_ORDER_STATUSES,
  transitions: {
    CONFIRMED: ['IN_PRODUCTION', 'PARTLY_SHIPPED', 'SHIPPED', 'CANCELLED'],
    IN_PRODUCTION: ['READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CANCELLED'],
    READY: ['PARTLY_SHIPPED', 'SHIPPED', 'CANCELLED'],
    PARTLY_SHIPPED: ['SHIPPED'],
    SHIPPED: ['PARTLY_SHIPPED', 'CLOSED'],
  },
  guards: {
    IN_PRODUCTION: (facts) => ((facts.releasedWorkOrders ?? 0) > 0 ? [] : ['a released work order of its lines']),
    READY: (facts) => (facts.released === true || hasReason(facts) ? [] : ['every ordered piece released by quality, or a reason (quality release is not in use yet)']),
    PARTLY_SHIPPED: (facts) => (facts.shipped === 'PARTLY' ? [] : ['part of the order shipped and part not']),
    SHIPPED: (facts) => (facts.shipped === 'ALL' ? [] : ['every ordered piece shipped']),
    CLOSED: (facts) =>
      facts.settlement?.settled === true || hasReason(facts) ? [] : [`every line shipped, invoiced and paid (${missingWords(facts.settlement)}), or a reason to close it anyway`],
    // B-W2a-30 (SAL-211): released work orders no longer stop it; they are left behind and named by the impact check.
    CANCELLED: (facts) => [
      ...(hasReason(facts) ? [] : ['a reason for the cancellation']),
      ...((facts.draftWorkOrders ?? []).length > 0 ? [`its draft work orders cancelled first (${(facts.draftWorkOrders ?? []).join(', ')})`] : []),
      ...(facts.cancelBlocks ?? []),
    ],
  },
})

/**
 * The moves the facts ask the system to make now, in order (the worker's handlers on workorder.released,
 * shipment.status_changed and the settle events): production started, quality released everything, the shipped
 * quantities, and the close of a settled order that left in full. A person's reason never takes part (the system moves on
 * facts only). Empty: nothing to do.
 */
export function followMoves(status: SalesOrderStatus, facts: SalesOrderFacts): SalesOrderStatus[] {
  const systemFacts: SalesOrderFacts = { ...facts, reason: null }
  const moves: SalesOrderStatus[] = []
  let current = status
  const step = (to: SalesOrderStatus): void => {
    if (current !== to && canTransition(salesOrderMachine, current, to, systemFacts).ok) {
      moves.push(to)
      current = to
    }
  }
  const shipped = facts.shipped ?? 'NONE'
  if (current === 'CONFIRMED' && (facts.releasedWorkOrders ?? 0) > 0) step('IN_PRODUCTION')
  if (current === 'IN_PRODUCTION' && facts.released === true && shipped === 'NONE') step('READY')
  if (shipped === 'ALL') step('SHIPPED')
  else if (shipped === 'PARTLY') step('PARTLY_SHIPPED')
  if (current === 'SHIPPED' && facts.settlement?.settled === true) step('CLOSED')
  return moves
}

// ---- per line × size progress -------------------------------------------------------------------------------------------

/** Pieces of one order line and size (size null: a made-to-measure unit, counted by its line). */
export interface PieceCount {
  readonly lineId: string
  readonly size: string | null
  readonly quantity: number
}

export interface ProgressLine {
  readonly id: string
  readonly seq: number
  /** The line's pieces (a made-to-measure unit: 1). */
  readonly quantity: number
  /** Its size grid as ordered; empty for a made-to-measure unit. */
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

export interface ProgressFacts {
  readonly lines: readonly ProgressLine[]
  /** Pieces in work orders that are not cancelled. */
  readonly inWorkOrders: readonly PieceCount[]
  /** Released by quality, less the reversals. */
  readonly released: readonly PieceCount[]
  /** On shipments that left (SHIPPED or DELIVERED). */
  readonly shipped: readonly PieceCount[]
  /** Billed by issued invoices (TD01, TD24) less issued credit notes (TD04): Decimal(18,4) strings. */
  readonly invoiced: readonly { readonly lineId: string; readonly size: string | null; readonly quantity: string }[]
  /** B-W2a-30 (SAL-210): the lines closed short (what was left of them will not be made or shipped). */
  readonly closedShort?: ReadonlySet<string>
}

/** The numbers of one size of one line (or of a made-to-measure unit). */
export interface Progress {
  readonly ordered: number
  readonly inWorkOrders: number
  /** Counted from the floor's scans (B-W1-42): null until they exist, never a made-up 0. */
  readonly made: null
  readonly released: number
  readonly shipped: number
  /** A decimal string (an invoice line may bill part of a piece only in theory: FatturaPA quantities have 4 places). */
  readonly invoiced: string
  /** Ordered and not shipped yet (never below 0); 0 once the line is closed short. */
  readonly toShip: number
  /** B-W2a-30: pieces closed short (the line's remaining pieces that will not be made or shipped); 0 while open. */
  readonly closedShort: number
}

export interface ProgressRow extends Progress {
  readonly lineId: string
  readonly seq: number
  readonly size: string | null
}

export interface OrderProgress {
  readonly rows: readonly ProgressRow[]
  readonly lines: readonly ({ readonly lineId: string; readonly seq: number } & Progress)[]
  readonly totals: Progress
  readonly shipped: ShippedState
  /** Quality released every ordered piece. */
  readonly released: boolean
}

const keyOf = (lineId: string, size: string | null): string => `${lineId}|${size ?? ''}`
const decimalText = (value: Decimal): string => value.toFixed()

function add(rows: Progress[]): Progress {
  const invoiced = rows.reduce((total, row) => total.plus(new Dec(row.invoiced)), ZERO as Decimal)
  return {
    ordered: rows.reduce((total, row) => total + row.ordered, 0),
    inWorkOrders: rows.reduce((total, row) => total + row.inWorkOrders, 0),
    made: null,
    released: rows.reduce((total, row) => total + row.released, 0),
    shipped: rows.reduce((total, row) => total + row.shipped, 0),
    invoiced: decimalText(invoiced),
    toShip: rows.reduce((total, row) => total + row.toShip, 0),
    closedShort: rows.reduce((total, row) => total + row.closedShort, 0),
  }
}

/**
 * Per line × size: ordered, in work orders, made (null until scans), released, shipped, invoiced, still to ship; the
 * totals per line and for the order; how much left (ALL when every size shipped as ordered, PARTLY when anything left);
 * whether quality released everything. A made-to-measure line (no size rows) counts every piece of its line. A line
 * closed short (B-W2a-30) counts as done: its sizes' remaining pieces are `closedShort`, nothing of it is to ship; ALL
 * then means every size shipped or closed, and something shipped.
 */
export function orderProgress(facts: ProgressFacts): OrderProgress {
  const sizeless = new Set(facts.lines.filter((line) => line.sizes.length === 0).map((line) => line.id))
  const keyFor = (lineId: string, size: string | null): string => (sizeless.has(lineId) ? keyOf(lineId, null) : keyOf(lineId, size))
  const tally = (counts: readonly PieceCount[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const count of counts) map.set(keyFor(count.lineId, count.size), (map.get(keyFor(count.lineId, count.size)) ?? 0) + count.quantity)
    return map
  }
  const work = tally(facts.inWorkOrders)
  const released = tally(facts.released)
  const shipped = tally(facts.shipped)
  const invoiced = new Map<string, Decimal>()
  for (const row of facts.invoiced) invoiced.set(keyFor(row.lineId, row.size), (invoiced.get(keyFor(row.lineId, row.size)) ?? ZERO).plus(new Dec(row.quantity)))

  const closed = facts.closedShort ?? new Set<string>()
  const rows: ProgressRow[] = []
  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    const sizes = line.sizes.length > 0 ? line.sizes.map((entry) => ({ size: entry.size as string | null, ordered: entry.quantity })) : [{ size: null, ordered: line.quantity }]
    for (const entry of sizes) {
      const key = keyFor(line.id, entry.size)
      const out = shipped.get(key) ?? 0
      const short = closed.has(line.id) ? Math.max(0, entry.ordered - out) : 0
      rows.push({
        lineId: line.id,
        seq: line.seq,
        size: entry.size,
        ordered: entry.ordered,
        inWorkOrders: work.get(key) ?? 0,
        made: null,
        released: Math.max(0, released.get(key) ?? 0),
        shipped: out,
        invoiced: decimalText(invoiced.get(key) ?? ZERO),
        toShip: short > 0 ? 0 : Math.max(0, entry.ordered - out),
        closedShort: short,
      })
    }
  }
  const lines = facts.lines
    .map((line) => ({ lineId: line.id, seq: line.seq, ...add(rows.filter((row) => row.lineId === line.id)) }))
    .sort((a, b) => a.seq - b.seq)
  const any = rows.some((row) => row.shipped > 0)
  const all = any && rows.every((row) => row.shipped + row.closedShort >= row.ordered)
  return {
    rows,
    lines,
    totals: add(rows),
    shipped: all ? 'ALL' : any ? 'PARTLY' : 'NONE',
    released: rows.length > 0 && rows.every((row) => row.released + row.closedShort >= row.ordered),
  }
}

// ---- dates ------------------------------------------------------------------------------------------------------------

const dayNumber = (day: BusinessDate): number => Date.parse(`${day}T00:00:00.000Z`) / 86_400_000

/** Whole days past the promise date of an order not shipped yet (0 on time; null without a promise or once shipped). */
export function daysLate(status: SalesOrderStatus, promiseDate: BusinessDate | null, today: BusinessDate): number | null {
  if (promiseDate === null || !OPEN_STATUSES.includes(status)) return null
  return today <= promiseDate ? 0 : Math.round(dayNumber(today) - dayNumber(promiseDate))
}

export const MAX_REASON = 1000

export interface PromiseChange {
  readonly status: SalesOrderStatus
  /** The order's promise now. */
  readonly current: BusinessDate | null
  readonly promiseDate: BusinessDate
  readonly reason: string | null | undefined
  /** The lines asked for (empty: the whole order). */
  readonly lineIds: readonly string[]
  /** The order's lines. */
  readonly knownLineIds: readonly string[]
  readonly today: BusinessDate
}

/**
 * What stops a promise change (SAL-206; the design's "Change promise date" dialog): a reason, a day from today on, a
 * different day for the whole order, lines of this order (each once). The first promise is never overwritten (the
 * caller keeps originalPromiseDate; a first promise sets it). A final order and a line change after shipping started are
 * state refusals the caller makes (`promiseStateProblem`).
 */
export function promiseProblems(change: PromiseChange): Issue[] {
  const issues: Issue[] = []
  if (typeof change.reason !== 'string' || change.reason.trim() === '') issues.push({ path: 'body/reason', message: 'Say why the promise changes (it stays in the order history).' })
  if (change.promiseDate < change.today) issues.push({ path: 'body/promiseDate', message: `A new promise is a day from today (${change.today}) on.` })
  if (change.lineIds.length === 0 && change.current === change.promiseDate) issues.push({ path: 'body/promiseDate', message: `The order is already promised for ${change.promiseDate}.` })
  const seen = new Set<string>()
  change.lineIds.forEach((lineId, index) => {
    if (!change.knownLineIds.includes(lineId)) issues.push({ path: `body/lineIds/${index}`, message: 'Not a line of this order.' })
    else if (seen.has(lineId)) issues.push({ path: `body/lineIds/${index}`, message: 'This line is named twice.' })
    seen.add(lineId)
  })
  return issues
}

/** Why the order's promise (or its lines' promises) cannot change in this state; null when it can. */
export function promiseStateProblem(status: SalesOrderStatus, lines: boolean): string | null {
  if (FINAL_STATUSES.includes(status)) return `The order is ${status}; its dates no longer change.`
  if (lines && !LINE_CHANGE_STATUSES.includes(status)) return `The order is ${status}: its lines are fixed once anything shipped; change the order's promise instead.`
  return null
}

// ---- the order of an accepted version ---------------------------------------------------------------------------------

/** The accepted version, as the order copies it. */
export interface AcceptedVersion {
  readonly taxMode: PartyTaxMode
  readonly currency: string
  readonly language: string
  readonly billTo: unknown
  readonly shipTo: unknown
  readonly paymentTerms: string | null
  readonly promiseDate: BusinessDate | null
  readonly noWithdrawal: boolean
  readonly depositAmount: number | null
  readonly netAmount: number
  readonly vatAmount: number
  readonly grossAmount: number
  readonly costAmount: number | null
  /** The quote's: the party's own reference. */
  readonly customerRef: string | null
  /** The acceptance's day (Europe/Rome): the order's date. */
  readonly acceptedOn: BusinessDate
}

/** One line of the accepted version with its sizes (prices on the version's basis, decimals as strings). */
export interface AcceptedLine {
  readonly id: string
  readonly seq: number
  readonly kind: SalesLineKind
  readonly styleId: string
  readonly styleRevisionId: string | null
  /** The line's revision is the style's RELEASED one now (only then the order fixes it; else the work order picks it). */
  readonly revisionReleased: boolean
  readonly colourwayId: string
  readonly measurementProfileId: string | null
  readonly baseSize: string | null
  readonly description: string | null
  readonly note: string | null
  readonly quantity: number
  readonly unitPrice: string
  readonly netAmount: number
  readonly vatRatePct: string
  readonly vatNature: string | null
  readonly vatAmount: number
  readonly unitCost: string | null
  readonly costAmount: number | null
  readonly sizes: readonly { readonly size: string; readonly quantity: number; readonly unitPrice: string | null }[]
}

export interface OrderDraft {
  readonly header: {
    readonly status: 'CONFIRMED'
    readonly orderDate: BusinessDate
    readonly currency: string
    readonly language: string
    readonly taxMode: PartyTaxMode
    readonly billTo: unknown
    readonly shipTo: unknown
    readonly paymentTerms: string | null
    readonly customerRef: string | null
    readonly requestedDate: null
    readonly promiseDate: BusinessDate | null
    /** The first promise: the accepted version's delivery date, set once here and never overwritten. */
    readonly originalPromiseDate: BusinessDate | null
    readonly priority: 0
    readonly noWithdrawal: boolean
    /** The version asks a deposit: production waits for it (the work orders' deposit gate). */
    readonly depositRequired: boolean
    readonly netAmount: number
    readonly vatAmount: number
    readonly grossAmount: number
    readonly costAmount: number | null
  }
  readonly lines: readonly (Omit<AcceptedLine, 'id' | 'revisionReleased' | 'styleRevisionId'> & { readonly quoteLineId: string; readonly styleRevisionId: string | null })[]
  /** The basis the copied unit prices are on (the order's tax mode says it again: priceBasisOf). */
  readonly priceBasis: PriceBasis
}

/**
 * The order of an accepted version (SAL-200 "quote to order in one step", SAL-203): its lines and size grids as
 * accepted, unit prices on the version's basis (net for a business, VAT included for a consumer) with the VAT and the
 * costs, the version's totals, tax mode, currency, language, buyer and delivery address, payment terms and promise date
 * (also the first promise). A line's style revision is fixed only when it is the style's RELEASED one (a quote may be
 * priced on a draft revision: the work order chooses then).
 */
export function orderFromVersion(version: AcceptedVersion, lines: readonly AcceptedLine[]): OrderDraft {
  return {
    header: {
      status: 'CONFIRMED',
      orderDate: version.acceptedOn,
      currency: version.currency,
      language: version.language,
      taxMode: version.taxMode,
      billTo: version.billTo,
      shipTo: version.shipTo,
      paymentTerms: version.paymentTerms,
      customerRef: version.customerRef,
      requestedDate: null,
      promiseDate: version.promiseDate,
      originalPromiseDate: version.promiseDate,
      priority: 0,
      noWithdrawal: version.noWithdrawal,
      depositRequired: (version.depositAmount ?? 0) > 0,
      netAmount: version.netAmount,
      vatAmount: version.vatAmount,
      grossAmount: version.grossAmount,
      costAmount: version.costAmount,
    },
    lines: [...lines]
      .sort((a, b) => a.seq - b.seq)
      .map((line) => ({
        quoteLineId: line.id,
        seq: line.seq,
        kind: line.kind,
        styleId: line.styleId,
        styleRevisionId: line.revisionReleased ? line.styleRevisionId : null,
        colourwayId: line.colourwayId,
        measurementProfileId: line.measurementProfileId,
        baseSize: line.baseSize,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        netAmount: line.netAmount,
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        vatAmount: line.vatAmount,
        unitCost: line.unitCost,
        costAmount: line.costAmount,
        sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice })),
      })),
    priceBasis: priceBasisOf(version.taxMode),
  }
}

// ---- what a person may do next --------------------------------------------------------------------------------------

export const ORDER_ACTIONS = ['changePromise', 'markReady', 'cancel', 'close'] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]

export interface ActionView {
  readonly action: OrderAction
  /** It can run now (a reason may still be asked: `needsReason`). */
  readonly allowed: boolean
  readonly needsReason: boolean
  /** Why it is held, in words (null when allowed). */
  readonly held: string | null
}

/**
 * The record's actions by state (the design's band: the next step by state, held with its first blocking reason). Who
 * may run them is the API's (orders.manage; closing an order that is not settled also orders.close).
 */
export function orderActions(status: SalesOrderStatus, facts: SalesOrderFacts): ActionView[] {
  const actions: ActionView[] = []
  if (!FINAL_STATUSES.includes(status)) actions.push({ action: 'changePromise', allowed: true, needsReason: true, held: null })
  if (status === 'IN_PRODUCTION') actions.push({ action: 'markReady', allowed: true, needsReason: true, held: null })
  if (CANCEL_STATUSES.includes(status)) {
    const check = canTransition(salesOrderMachine, status, 'CANCELLED', { ...facts, reason: 'asked' })
    actions.push({ action: 'cancel', allowed: check.ok, needsReason: true, held: check.ok ? null : `Cancelling needs ${check.missing.join(' and ')}.` })
  }
  if (status === 'SHIPPED') {
    const settled = facts.settlement?.settled === true
    actions.push({
      action: 'close',
      allowed: true,
      needsReason: !settled,
      held: settled ? null : `Not settled: ${missingWords(facts.settlement)} Closing it anyway needs a reason and the right to close unsettled orders.`,
    })
  }
  return actions
}
