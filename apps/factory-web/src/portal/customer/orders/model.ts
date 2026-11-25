import type { MilestoneStep, PromiseMove } from '@nexus/ui/components/MilestoneTracker/index'
import type { PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type {
  ApprovalPage,
  CancelBody,
  ChangeBody,
  ChangeRules,
  CustomerOrderStatus,
  CustomerShipmentStatus,
  DepositRead,
  OrderMilestone,
  OrderRecord,
  OrderRow,
  PaymentIntent,
  PromiseMoveRead,
  RevisedOrder,
  RuleLine,
  ShipmentRead,
  VerdictCode,
} from './api'
import { VERDICT_CODES } from './api'
// B-TH-223: the customer's requests beside its orders.
import type { RequestRow } from '../requests/api'
import { requestHref, yourNumberText } from '../requests/model'
// B-TH-275: the portal record frame's tab rule and a record's conversation page.
import { conversationHref, tabOrFirst } from '../../shell/record/model'

/**
 * SCR-184 — the customer's Orders & tracking (B-W2b-191; design portal.customer.orders), pure: the list's address, the
 * record's tabs, tones, the steps of the MilestoneTracker, the promise moves, the change and cancel asks (what the API
 * takes, what they come to, why Send waits), the re-confirmation, the deposit payment's state, money and the CSV. No call,
 * no React: the containers read, the views draw, these rules decide (the tests hold them).
 */

export const NS = 'portal-orders'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────
// ---- B-TH-275 (P-CUS-ORD.body; tabs 5 → 4): the Messages tab is gone — the order's conversation docks beside every tab (the portal
// record frame, B-TH-273). An old `?tab=messages` (a list's link, a mail, a notification) opens the first tab with the
// conversation shown and its box focused (the frame's arrival rule), and so does any address the page does not know.
// pp-w1 (w1.3; D2 a, L5): round 1's tabs in the office's words — Overview · Lines · Shipments · Files (Money comes with its own
// round). The old addresses keep working: `?tab=status` opens Overview, `?tab=documents` opens Files (links in mails, My production).
export const RECORD_TABS = ['overview', 'lines', 'shipments', 'files'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const OLD_RECORD_TABS: Readonly<Record<string, RecordTab>> = Object.freeze({ status: 'overview', documents: 'files' })
export const tabOf = (value: string | null | undefined): RecordTab => tabOrFirst(RECORD_TABS, value, OLD_RECORD_TABS)
// ---- end B-TH-275

export function recordHref(prefix: string, id: string, tab: RecordTab = 'overview', extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams({ tab, ...extra })
  return `${prefix}/orders/${encodeURIComponent(id)}?${params.toString()}`
}

// ---- B-TH-275: "Messages" on a row (the list's menu, its New messages cell) opens the order with its conversation shown and the box
// focused: the frame's arrival term `tab=messages` (the page then reads Overview and cleans the address).
export const orderThreadHref = (prefix: string, id: string): string => `${prefix}/orders/${encodeURIComponent(id)}?tab=messages`

/**
 * The order as the customer names it (plan §0.5, B-TH-303: its own count, never the office's SO- series): "Your order 12" for the
 * band and the page, "#12" where one short reference is needed (a pop-up's title, the tracker's name); without a number of its own
 * yet, the customer's own PO, else "your order".
 */
export function orderNameOf(order: Pick<OrderRecord['order'], 'yourNumber' | 'customerRef'>, locale: Locale, t: Translate): string {
  if (order.yourNumber) return order.yourNumber.words[locale]
  return order.customerRef ? t('record.titleRef', { ref: order.customerRef }) : t('record.titleNone')
}
export function orderRefOf(order: Pick<OrderRecord['order'], 'yourNumber' | 'customerRef'>, t: Translate): string {
  if (order.yourNumber) return `#${order.yourNumber.seq}`
  return order.customerRef ?? t('record.refNone')
}

/**
 * The one state line above the tracker (L2-G06; B-TH-006): "Your order is confirmed" ONLY for a confirmed order — an order still
 * waiting for our approval (the office's PENDING_APPROVAL, REQUESTED to the customer) says it was received and waits for our yes;
 * any later state has its tracker and says nothing more here.
 */
export function stateLineKey(status: CustomerOrderStatus): 'status.confirmed' | 'status.waitsApproval' | null {
  if (status === 'CONFIRMED') return 'status.confirmed'
  if (status === 'REQUESTED') return 'status.waitsApproval'
  return null
}

/** What the order was made from, as the summary read names it (B-TH-076: its parent, only when the customer opens that one too). */
export interface SummaryParent {
  readonly recordType: string
  readonly recordId: string
  readonly label: string | null
}

/**
 * "Made from your request" (P-CUS-ORD.body): the order's request page, from the order's summary (a request it came from) or — an
 * order made from a quote — the quote's own summary (the request the quote came from). A quote with no request of the customer's is
 * named and opens its conversation page (the portal has no quote page yet). None: nothing drawn (an order the office typed).
 */
export function madeFromOf(prefix: string, orderParent: SummaryParent | null, quoteParent: SummaryParent | null): { readonly kind: 'request' | 'quote'; readonly href: string; readonly label: string | null } | null {
  const request = orderParent?.recordType === 'Inquiry' ? orderParent : quoteParent?.recordType === 'Inquiry' ? quoteParent : null
  if (request) return { kind: 'request', href: requestHref(prefix, request.recordId), label: request.label }
  if (orderParent?.recordType === 'Quote') return { kind: 'quote', href: conversationHref(prefix, { type: 'Quote', id: orderParent.recordId }), label: orderParent.label }
  return null
}
// ---- end B-TH-275

/** A row opens its order; a request sent and not decided yet has no page of its own (it is not an order yet). */
export const opens = (row: Pick<OrderRow, 'kind'>): boolean => row.kind === 'ORDER'

// ── tones ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// pp-t: the order's status pill is the shared lib status chip's (`customerStatusTone`, lib/order-cells/model.ts); statusTone went.

export function shipmentTone(status: CustomerShipmentStatus): Tone {
  switch (status) {
    case 'DELIVERED':
      return 'success'
    case 'DELAYED':
    case 'RETURNED':
      return 'warning'
    case 'IN_TRANSIT':
    case 'OUT_FOR_DELIVERY':
      return 'info'
    default:
      return 'neutral'
  }
}

export const requestTone = (status: string): Tone => (status === 'ACCEPTED' ? 'success' : status === 'REFUSED' ? 'danger' : status === 'OPEN' ? 'warning' : 'neutral')

// ── money (minor units; only with the price grain) ───────────────────────────────────────────────────────────────────
/** "1.234,50 €" in the page's language; null without the price grain. */
export function moneyText(minor: number | null | undefined, currency: string | null | undefined, locale: Locale): string | null {
  if (minor === null || minor === undefined || !currency) return null
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit price as the API writes it ("185.000000"), 2 to 4 decimals. */
export function unitPriceText(text: string | null | undefined, currency: string, locale: Locale): string | null {
  if (text === null || text === undefined) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return formatNumber(value, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

export const pieceCount = (n: number, locale: Locale): string => formatNumber(n, locale, { maximumFractionDigits: 0 })

// ── the tracker ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The API's six steps as the DS MilestoneTracker draws them (dates written by the page). */
export function milestoneSteps(milestones: readonly OrderMilestone[], locale: Locale, day: (iso: string) => string): MilestoneStep[] {
  return milestones.map((step) => ({
    id: step.key,
    label: step.words[locale],
    state: step.state === 'DONE' ? 'done' : step.state === 'PARTLY' ? 'partly' : step.state === 'SKIPPED' ? 'skipped' : 'todo',
    current: step.current,
    date: step.date ? day(step.date) : null,
    expected: step.state === 'TODO' && step.expected ? day(step.expected) : null,
  }))
}

// ── F-OP-124 (order page plan N5): the number of a carrier booked by hand, as the shipment card shows it ──
/** The typed tracking number of a shipment (no carrier feeds it: the card says "No live tracking"); null: none typed. */
export function typedTrackingOf(shipment: Pick<ShipmentRead, 'typedTrackingNumber'>): string | null {
  const number = shipment.typedTrackingNumber?.trim() ?? ''
  return number === '' ? null : number
}
// ── end F-OP-124 ──

// ── F-OP-135 (order page plan N6; B-OP-034, B-OP-044): the typed link and a shared shipment, as the customer sees them ──
/** The card's Track › beside a typed number: the link typed with it, https only (checked again here); null: none. */
export function typedLinkOf(shipment: Pick<ShipmentRead, 'typedTrackingNumber' | 'typedTrackingUrl'>): string | null {
  if (!typedTrackingOf(shipment)) return null
  const url = shipment.typedTrackingUrl?.trim() ?? ''
  return /^https:\/\/\S+$/i.test(url) ? url : null
}

/**
 * A shipment that also carries other orders of THIS customer names them by the customer's own numbers only ("Also 3 pieces of your
 * order #12"; its PO without a number of its own) — the read never lists another customer's order, and the office's series never shows.
 */
export function alsoCarriesOf(shipment: Pick<ShipmentRead, 'otherOrders'>, t: Translate): string[] {
  return (shipment.otherOrders ?? []).filter((order) => order.pieces > 0).map((order) => t('shipments.also', { count: order.pieces, order: orderRefOf(order, t) }))
}
// ── end F-OP-135 ──

/** A shipment's four steps (Packed · Collected · In transit · Delivered). */
export function shipmentSteps(shipment: Pick<ShipmentRead, 'milestones'>, locale: Locale, at: (iso: string) => string): MilestoneStep[] {
  // The step it is at now is the furthest one reached (the next one is still to come, not "now").
  const furthest = shipment.milestones.filter((step) => step.done).at(-1)?.key
  return shipment.milestones.map((step) => ({ id: step.key, label: step.words[locale], state: step.done ? 'done' : 'todo', current: step.key === furthest, date: step.at ? at(step.at) : null }))
}

/** The promise history, oldest first, in the customer's words (curated reasons, never the office's notes). */
export function promiseMoves(history: readonly PromiseMoveRead[], locale: Locale, day: (iso: string) => string): PromiseMove[] {
  return [...history]
    .sort((a, b) => a.on.localeCompare(b.on))
    .map((move) => ({ on: day(move.on), from: move.from ? day(move.from) : null, to: day(move.to), reason: move.reason?.words[locale] ?? null /* B-OL-004 */ }))
}

/** How many times the promise moved (a first date set is not a move). */
export const movesOf = (history: readonly PromiseMoveRead[]): number => history.filter((move) => move.from !== null && move.from !== move.to).length

/** The promise date of the order, and whether it moved since it was first given. */
export function promiseOf(order: Pick<OrderRecord['order'], 'promiseDate' | 'originalPromiseDate' | 'promiseMoved'>): { date: string | null; first: string | null } {
  return { date: order.promiseDate, first: order.promiseMoved && order.originalPromiseDate && order.originalPromiseDate !== order.promiseDate ? order.originalPromiseDate : null }
}

// ── order facts ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The delivery address as agreed, line by line (the order's snapshot; unknown keys left out). */
export function shipToLines(shipTo: Readonly<Record<string, unknown>>): string[] {
  const text = (key: string) => (typeof shipTo[key] === 'string' && (shipTo[key] as string).trim() !== '' ? (shipTo[key] as string).trim() : null)
  const place = [text('postalCode'), text('city'), text('province') ? `(${text('province')})` : null].filter(Boolean).join(' ')
  return [text('name'), text('line1'), text('line2'), place || null, text('country'), text('contactName')].filter((line): line is string => line !== null)
}

/** The deposits that still wait for money (OPEN). */
export const openDeposits = (deposits: readonly DepositRead[]): DepositRead[] => deposits.filter((deposit) => deposit.status === 'OPEN')

/**
 * The deposits paid, in minor units (null without the grain). F-OM-204 (B-OM-005, M3-B6): what the payments placed on each request
 * (a part payment counts, not only a request PAID in full); an older answer without it: the PAID requests' amounts, as before.
 */
export function depositPaid(deposits: readonly DepositRead[]): number | null {
  if (deposits.some((deposit) => deposit.amount === undefined || deposit.amount === null)) return deposits.length === 0 ? 0 : null
  if (deposits.every((deposit) => typeof deposit.paidAmount === 'number')) return deposits.filter((deposit) => deposit.status !== 'CANCELLED').reduce((sum, deposit) => sum + (deposit.paidAmount ?? 0), 0)
  return deposits.filter((deposit) => deposit.status === 'PAID').reduce((sum, deposit) => sum + (deposit.amount ?? 0), 0)
}

/**
 * Net · VAT · total · deposit paid · to pay (null without the grain). F-OM-204 (B-OM-005): to pay is the office's own still-to-pay
 * when the read sends it (one rule for the office and the portal), else the total less the deposits paid.
 */
export function totalsOf(record: Pick<OrderRecord, 'order' | 'deposits'>): { net: number; vat: number; gross: number; depositPaid: number; toPay: number } | null {
  const { netAmount, vatAmount, grossAmount } = record.order
  const paid = depositPaid(record.deposits)
  if (netAmount == null || vatAmount == null || grossAmount == null || paid === null) return null
  return { net: netAmount, vat: vatAmount, gross: grossAmount, depositPaid: paid, toPay: typeof record.order.stillToPay === 'number' ? record.order.stillToPay : Math.max(0, grossAmount - paid) }
}

/** A line's own promise when it differs from the order's. */
export const linePromise = (line: { promiseDate: string | null }, order: { promiseDate: string | null }): string | null => (line.promiseDate && line.promiseDate !== order.promiseDate ? line.promiseDate : null)

/**
 * pp-w1 (w1.4, O3-B1): the lines Lines and the tab strip draw — every line but a charge (FEE). Round 1 draws no charge line (the
 * Lines round gives charges their row); the order's totals already count it, and the change rules never list it.
 */
export const shownLinesOf = <L extends { readonly kind: string }>(lines: readonly L[]): L[] => lines.filter((line) => line.kind !== 'FEE')

// ── the change request (pop:change-request) ────────────────────────────────────────────────────────────────────────────
export interface ChangeDraft {
  /** Line → size → pieces wanted (only what the person touched; everything else stays as ordered). */
  cells: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** "We would like it by" (empty: unchanged). */
  requestedDate: string
  /** One of their delivery addresses (empty: unchanged). */
  shipToAddressId: string
  note: string
  step: 'edit' | 'review'
  /** The line the pop-up was opened from (a line's ⋯). */
  focusLine: string | null
  /** F-PR-23b (B-PR-27a): line → the other colourway of its style asked (absent / empty: the line keeps its own). */
  colourways?: Readonly<Record<string, string>>
}

export const EMPTY_CHANGE: ChangeDraft = { cells: {}, requestedDate: '', shipToAddressId: '', note: '', step: 'edit', focusLine: null }
export const MAX_NOTE = 2000

/** The line's sizes as ordered (size → pieces). */
export const orderedSizes = (line: RuleLine): Record<string, number> => Object.fromEntries(line.sizes.map((size) => [size.size, size.quantity]))

/** A line's sizes as the person wants them now: ordered, with what they touched over it. */
export function wantedSizes(line: RuleLine, draft: Pick<ChangeDraft, 'cells'>): Record<string, number> {
  return { ...orderedSizes(line), ...(draft.cells[line.lineId] ?? {}) }
}

/** The cells that differ from the order (what is asked), in line and size order. */
export function changedCells(rules: Pick<ChangeRules, 'lines'>, draft: Pick<ChangeDraft, 'cells'>): { lineId: string; seq: number; size: string; before: number; after: number }[] {
  const out: { lineId: string; seq: number; size: string; before: number; after: number }[] = []
  for (const line of rules.lines) {
    const touched = draft.cells[line.lineId]
    if (!touched) continue
    for (const size of line.sizes) {
      const after = touched[size.size]
      if (after !== undefined && after !== size.quantity) out.push({ lineId: line.lineId, seq: line.seq, size: size.size, before: size.quantity, after })
    }
  }
  return out
}

/** A line every piece of which would go: "ask to cancel that line instead" (the API refuses it). */
export function emptiedLines(rules: Pick<ChangeRules, 'lines'>, draft: Pick<ChangeDraft, 'cells'>): number[] {
  return rules.lines.filter((line) => draft.cells[line.lineId] && Object.values(wantedSizes(line, draft)).every((pieces) => pieces === 0)).map((line) => line.seq)
}

// ---- F-PR-23b (B-PR-27a #1626): a line in another colourway of its style (the API takes it; Sales accepts it as a new line) ----
/** The colourways asked, only of the order's own lines and only one its style offers (the wall: nothing else is named). */
export function colourwaysAsked(rules: Pick<ChangeRules, 'lines'>, draft: Pick<ChangeDraft, 'colourways'>): { lineId: string; colourwayId: string }[] {
  const asked = draft.colourways ?? {}
  return rules.lines.flatMap((line) => {
    const id = asked[line.lineId]
    return id && (line.colourways ?? []).some((colourway) => colourway.id === id) ? [{ lineId: line.lineId, colourwayId: id }] : []
  })
}

/** The sizes a picked colourway is not made in that the line would still hold pieces of ("set it to 0 or pick another"). */
export function colourSizeProblems(rules: Pick<ChangeRules, 'lines'>, draft: Pick<ChangeDraft, 'cells' | 'colourways'>): { seq: number; size: string }[] {
  return colourwaysAsked(rules, draft).flatMap((asked) => {
    const line = rules.lines.find((entry) => entry.lineId === asked.lineId)
    const colourway = line?.colourways?.find((entry) => entry.id === asked.colourwayId)
    if (!line || !colourway) return []
    return Object.entries(wantedSizes(line, draft))
      .filter(([size, pieces]) => pieces > 0 && !colourway.sizes.includes(size))
      .map(([size]) => ({ seq: line.seq, size }))
  })
}
// ---- end F-PR-23b

/** What "Send request" sends (only what changed). */
export function changeBodyOf(rules: ChangeRules, draft: ChangeDraft): ChangeBody {
  const note = draft.note.trim()
  const colourways = colourwaysAsked(rules, draft) // F-PR-23b
  return {
    kind: 'CHANGE',
    cells: changedCells(rules, draft).map((cell) => ({ lineId: cell.lineId, size: cell.size, quantity: cell.after })),
    ...(draft.requestedDate && draft.requestedDate !== (rules.order.requestedDate ?? '') ? { requestedDate: draft.requestedDate } : {}),
    ...(draft.shipToAddressId ? { shipToAddressId: draft.shipToAddressId } : {}),
    ...(note ? { note } : {}),
    ...(colourways.length > 0 ? { colourways } : {}),
  }
}

/** Something to ask: a size, the date, the address or (F-PR-23b) a colourway. */
export const changeAsksSomething = (body: ChangeBody): boolean => body.cells.length > 0 || body.requestedDate !== undefined || body.shipToAddressId !== undefined || (body.colourways?.length ?? 0) > 0

export interface AskFacts {
  /** The person may ask (portal.salesOrders.ask), and this is not an office preview. */
  mayAsk: boolean
  preview: boolean
  offline: boolean
  busy: boolean
}

/** Why the change cannot go now (a message key), in the order the person fixes it; null when it may. */
export function changeHeld(rules: ChangeRules | null, draft: ChangeDraft, facts: AskFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.mayAsk) return 'held.mayAsk'
  if (!rules) return 'held.reading'
  if (!rules.change.possible) return 'held.verdict'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  if (emptiedLines(rules, draft).length > 0) return 'change.problem.emptied'
  if (colourSizeProblems(rules, draft).length > 0) return 'change.problem.colourSizes' // F-PR-23b
  if (draft.note.length > MAX_NOTE) return 'change.problem.long'
  if (!changeAsksSomething(changeBodyOf(rules, draft))) return 'change.problem.nothing'
  return null
}

// ── the cancel request (pop:cancel-request) ───────────────────────────────────────────────────────────────────────────
export interface CancelDraft {
  scope: 'ORDER' | 'LINES'
  lineIds: readonly string[]
  reasonCode: string
  note: string
  /** Send was pressed: the field problems show. */
  tried: boolean
  /** F-PR-13: edit, then review (what it means, before Send); absent: edit. */
  step?: 'edit' | 'review'
}

export const EMPTY_CANCEL: CancelDraft = { scope: 'ORDER', lineIds: [], reasonCode: '', note: '', tried: false }

/** The lines that may be asked to be cancelled now. */
export const cancellableLines = (rules: Pick<ChangeRules, 'lines'>): RuleLine[] => rules.lines.filter((line) => line.cancel.possible)

/** A cancel of every line that is still open is the whole order. */
export function cancelBodyOf(rules: ChangeRules, draft: CancelDraft): CancelBody {
  const note = draft.note.trim()
  const lines = draft.scope === 'LINES' ? draft.lineIds.filter((id) => rules.lines.some((line) => line.lineId === id && line.cancel.possible)) : []
  return { kind: 'CANCEL', ...(draft.scope === 'LINES' ? { lineIds: lines } : {}), reasonCode: draft.reasonCode, ...(note ? { note } : {}) }
}

/** The field the cancel waits on (a message key and its field), or a held reason; null when it may go. */
export function cancelHeld(rules: ChangeRules | null, draft: CancelDraft, facts: AskFacts): { key: string; field: 'scope' | 'reason' | 'note' | null } | null {
  if (facts.preview) return { key: 'held.preview', field: null }
  if (!facts.mayAsk) return { key: 'held.mayAsk', field: null }
  if (!rules) return { key: 'held.reading', field: null }
  if (draft.scope === 'ORDER' && !rules.cancel.possible) return { key: 'held.verdict', field: 'scope' }
  if (draft.scope === 'LINES' && cancellableLines(rules).length === 0) return { key: 'held.verdict', field: 'scope' }
  if (facts.offline) return { key: 'held.offline', field: null }
  if (facts.busy) return { key: 'held.busy', field: null }
  if (draft.scope === 'LINES' && cancelBodyOf(rules, draft).lineIds!.length === 0) return { key: 'cancel.problem.lines', field: 'scope' }
  if (!draft.reasonCode) return { key: 'cancel.problem.reason', field: 'reason' }
  const reason = rules.reasons.find((entry) => entry.code === draft.reasonCode)
  if (reason?.needsNote && draft.note.trim() === '') return { key: 'cancel.problem.note', field: 'note' }
  if (draft.note.length > MAX_NOTE) return { key: 'cancel.problem.long', field: 'note' }
  return null
}

/** The fee the cancel asked would cost now, in minor units (null: free or no price grain). */
export function cancelFeeOf(rules: ChangeRules, draft: CancelDraft): number | null {
  if (!rules.cancelFee?.pct) return null
  if (draft.scope === 'ORDER') return rules.cancelFee.wholeOrderFee ?? null
  const fees = rules.lines.filter((line) => draft.lineIds.includes(line.lineId) && line.cancel.possible).map((line) => line.cancelFee)
  if (fees.some((fee) => fee === undefined || fee === null)) return null
  return fees.reduce<number>((sum, fee) => sum + (fee ?? 0), 0)
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A refused ask in the page's words (a message key): a cut-off at the click names its verdict in the issue's path
 * (`body/cells/0/LEATHER_CUT`, `body/OPEN_REQUEST`) — then the rules are read again so the pop-up shows what holds now.
 */
export function askRefusal(error: unknown): { key: string; reread: boolean } {
  if (!isApiError(error)) return { key: 'problem.internal', reread: false }
  if (error.kind === 'conflict') {
    const code = error.issues.map((issue) => issuePath(issue).split(/[/.]/).pop() ?? '').find((last) => (VERDICT_CODES as readonly string[]).includes(last)) as VerdictCode | undefined
    return { key: code ? `problem.verdict.${code}` : 'problem.changed', reread: true }
  }
  if (error.kind === 'forbidden') return { key: 'problem.forbidden', reread: false }
  if (error.kind === 'not_found') return { key: 'problem.missing', reread: false }
  if (error.kind === 'invalid') return { key: 'problem.invalid', reread: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', reread: false }
  if (error.kind === 'unavailable') return { key: 'problem.unavailable', reread: false }
  return { key: 'problem.internal', reread: false }
}

// ── re-confirm version N (pop:reconfirm) ──────────────────────────────────────────────────────────────────────────────
export type ReconfirmDecision = 'APPROVED' | 'REFUSED'
export const MAX_ANSWER = 4000

/** The signed answer cannot go yet (a message key): a choice, then the reason of a decline. */
export function reconfirmProblem(decision: ReconfirmDecision | null, comment: string): string | null {
  if (decision === null) return 'reconfirm.problem.choose'
  if (decision === 'REFUSED' && comment.trim() === '') return 'reconfirm.problem.why'
  if (comment.length > MAX_ANSWER) return 'reconfirm.problem.long'
  return null
}

/** Why nobody can answer here now (a message key); null when the person may. */
export function reconfirmHeld(page: ApprovalPage | null, facts: { preview: boolean; mayApprove: boolean; offline: boolean }): string | null {
  if (facts.preview) return 'held.preview'
  if (!page) return 'held.reading'
  if (page.request.status !== 'OPEN') return 'reconfirm.held.answered'
  if (!facts.mayApprove) return 'held.mayApprove'
  if (!page.may.answer) return 'reconfirm.held.closed'
  if (facts.offline) return 'held.offline'
  return null
}

/** The sizes that moved on a revised line ("S 4 → 6"); unchanged sizes left out. */
export const sizeMoves = (line: RevisedOrder['lines'][number]) => line.sizes.filter((size) => size.before !== size.after)

/** The revised order's net moved: the earlier acceptance ends. */
export const netMoved = (order: RevisedOrder): boolean => order.netAmountBefore !== undefined && order.netAmountAfter !== undefined && order.netAmountBefore !== order.netAmountAfter

// ── the deposit paid online (pop:pay-deposit) ─────────────────────────────────────────────────────────────────────────
/** Where the payment stands, for the DS PaymentPanel. */
export function paymentStateOf(phase: 'idle' | 'starting' | 'ready' | 'paying', intent: Pick<PaymentIntent, 'status'> | null): PaymentState {
  if (intent?.status === 'SUCCEEDED') return 'succeeded'
  if (intent?.status === 'FAILED' || intent?.status === 'CANCELLED') return 'failed'
  if (phase === 'paying' && intent?.status === 'WAITING') return 'waiting'
  return phase
}

/** A payment the provider still decides: the page asks again every few seconds. */
export const POLL_MS = 2500
export const isFinal = (intent: Pick<PaymentIntent, 'status'> | null): boolean => intent !== null && (intent.status === 'SUCCEEDED' || intent.status === 'FAILED' || intent.status === 'CANCELLED')

/** Why "Pay by card" cannot open (a message key); null when it may. */
export function payHeld(facts: { preview: boolean; mayPay: boolean; cardAvailable: boolean; canPay: boolean; offline: boolean }): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.mayPay) return 'held.mayPay'
  if (!facts.cardAvailable) return 'deposit.card.unavailable'
  if (!facts.canPay) return 'deposit.card.notPayable'
  if (facts.offline) return 'held.offline'
  return null
}

// ── B-TH-223, B-TH-303: Orders & requests ───────────────────────────────────────────────────────────────────────────────
/**
 * The customer's list holds its requests (GET /portal/inquiries, the request like an e-mail) and its orders (with a catalogue
 * order still waiting for us, `kind` REQUEST of the orders' read). A row is one of the two; each says what kind it is, its true
 * state and the customer's OWN number ("Your request 7", "Your order 12"): never the office's series (INQ-, SO-, RQ-), so no
 * customer reads another's volume from a number (Owner decision PR-06, pick A). Requests come first — the one that needs the
 * customer on top, then by their last move — then the orders as the API sorts them (by the promise date).
 */
export type ListRow = { kind: 'request'; id: string; request: RequestRow } | { kind: 'order'; id: string; order: OrderRow }

// pg-t (Z9): the old list's chips, tiles, chip counts and rows left with it; the list on the shared parts is pco/list-view-model.ts.

/**
 * What kind a row is, as words (a key of `portal-orders`). pg-fx4: an order request still waiting for us is "Order request", never
 * "Catalogue" (a draft may be described or a custom size, not from the catalogue).
 */
export const kindKey = (row: ListRow): string => (row.kind === 'request' ? 'kind.request' : row.order.kind === 'REQUEST' ? 'kind.orderRequest' : 'kind.order')

/** The customer's own number of a row, written: "Your request 7", "Your order 12"; null when it has none. */
export const yoursOf = (row: ListRow, locale: Locale): string | null => (row.kind === 'request' ? yourNumberText(row.request.yourNumber, locale) : yourNumberText(row.order.yourNumber ?? null, locale))

/** Where a row opens: the request's page, the order's page; a catalogue order still waiting for us has none yet. */
export function rowHref(prefix: string, row: ListRow): string | null {
  if (row.kind === 'request') return requestHref(prefix, row.request.id)
  return opens(row.order) ? recordHref(prefix, row.order.id) : null
}

// ---- B-TH-230: the New messages column — what each row's thread is, and its door ------------------------------------------------
/** The record whose thread a row is (a request; an order with its own page), or null: a catalogue request has no thread page yet. */
export function threadOf(row: ListRow): { readonly recordType: 'Inquiry' | 'SalesOrder'; readonly id: string } | null {
  if (row.kind === 'request') return { recordType: 'Inquiry', id: row.request.id }
  return opens(row.order) ? { recordType: 'SalesOrder', id: row.order.id } : null
}

/** The door of a row's New messages cell: the record's page with its conversation (a request's page holds it; an order docks it, B-TH-275). */
export function threadHref(prefix: string, row: ListRow): string | null {
  if (row.kind === 'request') return requestHref(prefix, row.request.id)
  return opens(row.order) ? orderThreadHref(prefix, row.order.id) : null
}
// ---- end B-TH-230

// ── J / K between orders (the list the person came from) ───────────────────────────────────────────────────────────
export const NAV_KEY = 'fw-portal-orders-nav'

/** The order before or after this one in the list last shown (null at an end or when the order is not in it). */
export function neighbourOf(ids: readonly string[], id: string, step: 1 | -1): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  return ids[at + step] ?? null
}

/** The shipments' copy of a carrier event: "In transit · Milano" (the carrier's own words stay theirs). */
export function eventLine(event: { words: { it: string; en: string }; location: string | null }, locale: Locale): string {
  return [event.words[locale], event.location].filter(Boolean).join(' · ')
}

/** The documents a reader sees first: the current versions, newest first, the earlier ones after their current one. */
export function documentsInOrder<T extends { current: boolean; date: string; replacedBy: { id: string | null } | null; id: string }>(items: readonly T[]): T[] {
  const current = items.filter((item) => item.current).sort((a, b) => b.date.localeCompare(a.date))
  const earlier = items.filter((item) => !item.current)
  const out: T[] = []
  for (const item of current) {
    out.push(item)
    out.push(...earlier.filter((old) => old.replacedBy?.id === item.id).sort((a, b) => b.date.localeCompare(a.date)))
  }
  out.push(...earlier.filter((old) => !out.includes(old)))
  return out
}

/** The order confirmation to open in a new tab: the current ORDER_CONFIRMATION's PDF. */
export function confirmationFileOf(items: readonly { kind: string; current: boolean; files: readonly { fileId: string; format: string }[] }[]): string | null {
  const doc = items.find((item) => item.kind === 'ORDER_CONFIRMATION' && item.current)
  return doc?.files.find((file) => file.format === 'PDF')?.fileId ?? doc?.files[0]?.fileId ?? null
}

// ── B-TH-246 (threads plan TH-4, picture 28; SHEET-G10, Owner decision 13; features SHEET.portal-sheet, portal-sheet-F07; wall W10,
// W17, W39): the customer's own sheet — the columns the office ticked for its portal (the API sends every customer's portal fields
// and this customer's own, never another's), read-only, each cell said in the customer's words and opening the customer's OWN page
// of the row (never an office page), and "Download all" written by the server in the customer's scope. ──
import { isMoneyValue, storedOf } from '@nexus/factory-domain/fields/values'
import { minorUnitsOf } from '@nexus/factory-domain/money/currency/currencies'
import type { PortalCell, PortalColumn } from './api'

/** A portal column's name in the person's language, with its unit. */
export const portalColumnLabel = (column: Pick<PortalColumn, 'labelIt' | 'labelEn' | 'unit'>, locale: Locale): string => `${locale === 'it' ? column.labelIt : column.labelEn}${column.unit ? ` (${column.unit})` : ''}`

/**
 * A cell in words: the API's words first (a list value's label, a linked record's name), else the value by its type — a number,
 * a day, an amount in its currency (the API sends it only with the price grain), yes / no in the page's words. Null: nothing.
 */
export function portalCellText(column: Pick<PortalColumn, 'type' | 'options'>, cell: PortalCell | undefined, locale: Locale, words: { yes: string; no: string; day: (value: string) => string }): string | null {
  if (!cell) return null
  const said = locale === 'it' ? cell.wordsIt : cell.wordsEn
  if (said) return said
  const stored = storedOf(cell.value)
  if (stored === null || stored === undefined) return null
  switch (column.type) {
    case 'MONEY': {
      if (!isMoneyValue(stored)) return null
      try {
        return formatNumber(stored.amount / 10 ** minorUnitsOf(stored.currency), locale, { style: 'currency', currency: stored.currency })
      } catch {
        return null
      }
    }
    case 'DATE':
      return typeof stored === 'string' ? words.day(stored) : null
    case 'YES_NO':
      return stored === true ? words.yes : words.no
    case 'NUMBER':
      return typeof stored === 'number' ? formatNumber(stored, locale, { maximumFractionDigits: 6 }) : null
    case 'SELECT': {
      const option = typeof stored === 'string' ? column.options?.find((entry) => entry.code === stored) : undefined
      return option ? (locale === 'it' ? option.labelIt : option.labelEn) : typeof stored === 'string' ? stored : null
    }
    case 'MULTI_SELECT': {
      const codes = Array.isArray(stored) ? stored.filter((code): code is string => typeof code === 'string') : []
      return codes.length === 0 ? null : codes.map((code) => { const option = column.options?.find((entry) => entry.code === code); return option ? (locale === 'it' ? option.labelIt : option.labelEn) : code }).join(', ')
    }
    default:
      return typeof stored === 'string' ? stored : typeof stored === 'number' ? String(stored) : null
  }
}

/** The portal columns of a read (none for the list's plain read). */
export const portalColumnsOf = (read: { readonly columns?: readonly PortalColumn[] | undefined } | null): readonly PortalColumn[] => read?.columns ?? []

/** "Download all": the file's name when the server names none (the list's name and the format). */
export const sheetFileName = (base: string, format: 'XLSX' | 'CSV'): string => `${base}.${format === 'XLSX' ? 'xlsx' : 'csv'}`
// ── end B-TH-246 ──
