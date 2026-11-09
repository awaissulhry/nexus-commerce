import type { MilestoneStep, PromiseMove } from '@nexus/ui/components/MilestoneTracker/index'
import type { PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { SHIPMENT_MILESTONE_WORDS, SHIPMENT_MILESTONES } from '@nexus/factory-domain/sales/portal-orders/shipments'
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
  OrderChip,
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

/**
 * SCR-184 — the customer's Orders & tracking (B-W2b-191; design portal.customer.orders), pure: the list's address, the
 * record's tabs, tones, the steps of the MilestoneTracker, the promise moves, the change and cancel asks (what the API
 * takes, what they come to, why Send waits), the re-confirmation, the deposit payment's state, money and the CSV. No call,
 * no React: the containers read, the views draw, these rules decide (the tests hold them).
 */

export const NS = 'portal-orders'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RECORD_TABS = ['status', 'lines', 'shipments', 'documents', 'messages'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'status')

/** The list's address: the chip (OPEN is the API's default and is left out) and the search. */
export function listQuery(chip: OrderChip | null, q: string, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams()
  if (chip && chip !== 'OPEN') params.set('chip', chip)
  if (q.trim()) params.set('q', q.trim())
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function recordHref(prefix: string, id: string, tab: RecordTab = 'status', extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams({ tab, ...extra })
  return `${prefix}/orders/${encodeURIComponent(id)}?${params.toString()}${tab === 'messages' ? '#messages' : ''}`
}

/** A row opens its order; a request sent and not decided yet has no page of its own (it is not an order yet). */
export const opens = (row: Pick<OrderRow, 'kind'>): boolean => row.kind === 'ORDER'

// ── tones ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function statusTone(status: CustomerOrderStatus): Tone {
  switch (status) {
    case 'DELIVERED':
      return 'success'
    case 'CANCELLED':
      return 'neutral'
    case 'REQUESTED':
      return 'warning'
    case 'SHIPPED':
    case 'PARTLY_SHIPPED':
    case 'READY':
      return 'info'
    default:
      return 'neutral'
  }
}

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

/** A shipment's four steps (Packed · Collected · In transit · Delivered). */
export function shipmentSteps(shipment: Pick<ShipmentRead, 'milestones'>, locale: Locale, at: (iso: string) => string): MilestoneStep[] {
  // The step it is at now is the furthest one reached (the next one is still to come, not "now").
  const furthest = shipment.milestones.filter((step) => step.done).at(-1)?.key
  return shipment.milestones.map((step) => ({ id: step.key, label: step.words[locale], state: step.done ? 'done' : 'todo', current: step.key === furthest, date: step.at ? at(step.at) : null }))
}

/** A parcel on its way, as the four steps (the in-transit read carries the state, not the steps). */
export function transitSteps(row: { status: CustomerShipmentStatus; shippedAt: string | null }, locale: Locale): MilestoneStep[] {
  const moving = row.status === 'IN_TRANSIT' || row.status === 'OUT_FOR_DELIVERY' || row.status === 'DELAYED' || row.status === 'DELIVERED'
  const done: Record<(typeof SHIPMENT_MILESTONES)[number], boolean> = { PACKED: true, COLLECTED: row.shippedAt !== null || moving, IN_TRANSIT: moving, DELIVERED: row.status === 'DELIVERED' }
  const furthest = SHIPMENT_MILESTONES.filter((key) => done[key]).at(-1)
  return SHIPMENT_MILESTONES.map((key) => ({ id: key, label: SHIPMENT_MILESTONE_WORDS[key][locale], state: done[key] ? 'done' : 'todo', current: key === furthest }))
}

/** The promise history, oldest first, in the customer's words (curated reasons, never the office's notes). */
export function promiseMoves(history: readonly PromiseMoveRead[], locale: Locale, day: (iso: string) => string): PromiseMove[] {
  return [...history]
    .sort((a, b) => a.on.localeCompare(b.on))
    .map((move) => ({ on: day(move.on), from: move.from ? day(move.from) : null, to: day(move.to), reason: move.reason.words[locale] }))
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

/** The deposits paid, in minor units (null without the grain). */
export function depositPaid(deposits: readonly DepositRead[]): number | null {
  if (deposits.some((deposit) => deposit.amount === undefined || deposit.amount === null)) return deposits.length === 0 ? 0 : null
  return deposits.filter((deposit) => deposit.status === 'PAID').reduce((sum, deposit) => sum + (deposit.amount ?? 0), 0)
}

/** Net · VAT · total · deposit paid · to pay on invoice (null without the grain). */
export function totalsOf(record: Pick<OrderRecord, 'order' | 'deposits'>): { net: number; vat: number; gross: number; depositPaid: number; toPay: number } | null {
  const { netAmount, vatAmount, grossAmount } = record.order
  const paid = depositPaid(record.deposits)
  if (netAmount == null || vatAmount == null || grossAmount == null || paid === null) return null
  return { net: netAmount, vat: vatAmount, gross: grossAmount, depositPaid: paid, toPay: Math.max(0, grossAmount - paid) }
}

/** A line's own promise when it differs from the order's. */
export const linePromise = (line: { promiseDate: string | null }, order: { promiseDate: string | null }): string | null => (line.promiseDate && line.promiseDate !== order.promiseDate ? line.promiseDate : null)

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

/** What "Send request" sends (only what changed). */
export function changeBodyOf(rules: ChangeRules, draft: ChangeDraft): ChangeBody {
  const note = draft.note.trim()
  return {
    kind: 'CHANGE',
    cells: changedCells(rules, draft).map((cell) => ({ lineId: cell.lineId, size: cell.size, quantity: cell.after })),
    ...(draft.requestedDate && draft.requestedDate !== (rules.order.requestedDate ?? '') ? { requestedDate: draft.requestedDate } : {}),
    ...(draft.shipToAddressId ? { shipToAddressId: draft.shipToAddressId } : {}),
    ...(note ? { note } : {}),
  }
}

/** Something to ask: a size, the date or the address. */
export const changeAsksSomething = (body: ChangeBody): boolean => body.cells.length > 0 || body.requestedDate !== undefined || body.shipToAddressId !== undefined

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

// ── the list's export (in the person's words; prices only with the grain) ───────────────────────────────────────────
const csvCell = (value: string): string => (/[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

export function ordersCsv(rows: readonly OrderRow[], t: Translate, locale: Locale, seesPrices: boolean, day: (iso: string) => string): string {
  const head = [t('col.yourPo'), t('col.ourOrder'), t('facts.orderedOn'), t('col.status'), t('facts.promise'), t('col.ordered'), t('col.shipped'), t('col.open'), ...(seesPrices ? [t('col.value'), t('col.currency')] : []), t('col.nextShipment')]
  const lines = rows.map((row) =>
    [
      row.customerRef ?? '',
      row.number ?? '',
      row.orderedOn ? day(row.orderedOn) : '',
      row.words[locale],
      row.promiseDate ? day(row.promiseDate) : '',
      String(row.pieces.ordered),
      String(row.pieces.shipped),
      String(row.pieces.open),
      ...(seesPrices ? [row.netAmount != null ? (row.netAmount / 100).toFixed(2) : '', row.currency] : []),
      row.nextShipment ? [row.nextShipment.number, row.nextShipment.words[locale], row.nextShipment.date ? day(row.nextShipment.date) : '', row.nextShipment.carrierName ?? ''].filter(Boolean).join(' · ') : '',
    ]
      .map(csvCell)
      .join(','),
  )
  return [head.map(csvCell).join(','), ...lines].join('\r\n')
}

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
