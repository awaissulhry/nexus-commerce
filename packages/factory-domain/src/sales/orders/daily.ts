import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { amendStateProblem } from '../amendments/amendments'
import { CANCEL_STATUSES, FINAL_STATUSES, type SalesOrderStatus } from './orders'

/**
 * A sales order every day (B-W2a-30; SAL-209, SAL-210, SAL-211, SAL-217; the design's order record band overflow:
 * Amend order, Close remaining lines, Cancel order with what it leaves behind, Copy as new quote), pure.
 *
 *   dailyActions   what the record may do besides the W1 moves (orders.ts orderActions), each held with its reason in
 *                  words
 *   closeShortPlan "Close remaining lines" (SAL-210): the pieces of a line that will not be made or shipped (what is left
 *                  of it after what shipped), while CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED; every line closed
 *                  or shipped in full and something shipped → the order is SHIPPED. Closing every line of an order that
 *                  shipped nothing is a cancellation, not a close
 *   reopenPlan     "Reopen lines" (its reversal) while the order is not closed (a SHIPPED order reopened goes back to
 *                  PARTLY_SHIPPED)
 *   cancelImpact   the cancel's impact check (SAL-211): what stops it (a draft work order, a shipment being packed, an
 *                  invoice of the order: never deleted, a credit note is Finance's), what it changes (its OPEN deposit
 *                  requests and payment steps are cancelled with it) and what it leaves behind, named (open work orders
 *                  and the leather they cut, reserved stock, purchase orders planning counted for it, a paid deposit and
 *                  its deposit invoice). Words carry no amount: the amounts travel beside them, with the price grain
 */

export const DAILY_ORDER_ACTIONS = ['amend', 'closeLines', 'reopenLines', 'copyAsQuote'] as const
export type DailyOrderAction = (typeof DAILY_ORDER_ACTIONS)[number]

/** Lines are closed short (and reopened) only in these states (the …_sales_w2a_guards line trigger). */
export const CLOSE_SHORT_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])
/** A SHIPPED order whose lines were closed may still reopen them (it goes back to PARTLY_SHIPPED first). */
export const REOPEN_STATUSES: readonly SalesOrderStatus[] = Object.freeze([...CLOSE_SHORT_STATUSES, 'SHIPPED'])

/** One line as the close reads it: its pieces, what shipped of it, whether it is closed short now. */
export interface ShortLine {
  readonly id: string
  readonly seq: number
  readonly quantity: number
  readonly shipped: number
  readonly closedShort: boolean
}

const leftOf = (line: ShortLine): number => Math.max(0, line.quantity - line.shipped)
const lineWord = (seq: number): string => `Line ${seq}`

export interface DailyActionView {
  readonly action: DailyOrderAction
  readonly allowed: boolean
  readonly held: string | null
}

/** The record's daily actions (the band's overflow), each held with its first reason. Who may run them is the API's. */
export function dailyActions(status: SalesOrderStatus, lines: readonly ShortLine[]): DailyActionView[] {
  const anyShipped = lines.some((line) => line.shipped > 0)
  const open = lines.filter((line) => !line.closedShort && leftOf(line) > 0)
  const amendProblem = amendStateProblem(status)
  const closeHeld = !CLOSE_SHORT_STATUSES.includes(status)
    ? `The order is ${status}: its lines are no longer closed.`
    : open.length === 0
      ? 'Nothing is left to close: every line shipped in full or is closed already.'
      : !anyShipped && open.length === lines.filter((line) => !line.closedShort).length && open.length === 1
        ? 'Nothing has shipped and this is the only open line: cancel the order instead.'
        : null
  const reopenHeld = !REOPEN_STATUSES.includes(status) ? `The order is ${status}: its closed lines stay closed.` : lines.some((line) => line.closedShort) ? null : 'No line is closed short.'
  return [
    { action: 'amend', allowed: amendProblem === null, held: amendProblem },
    { action: 'closeLines', allowed: closeHeld === null, held: closeHeld },
    { action: 'reopenLines', allowed: reopenHeld === null, held: reopenHeld },
    { action: 'copyAsQuote', allowed: true, held: null },
  ]
}

export interface ClosePlan {
  readonly close: readonly { readonly id: string; readonly seq: number; readonly closedShortQuantity: number }[]
  /** After the close every line is shipped in full or closed, and something shipped: the order is SHIPPED. */
  readonly done: boolean
}

/**
 * What "Close remaining lines" closes: the lines named (none: every open line with something left), each closed for
 * what is left of it (its pieces less what shipped of it). Refused, in words by path: another state, a line named twice
 * or not of the order, a line closed already or shipped in full, every line of an order that shipped nothing.
 */
export function closeShortPlan(status: SalesOrderStatus, lines: readonly ShortLine[], lineIds: readonly string[]): ClosePlan | Issue[] {
  if (!CLOSE_SHORT_STATUSES.includes(status)) return [{ path: 'body', message: `The order is ${status}: its lines are no longer closed short.` }]
  const issues: Issue[] = []
  const byId = new Map(lines.map((line) => [line.id, line]))
  const chosen: ShortLine[] = []
  if (lineIds.length === 0) {
    chosen.push(...lines.filter((line) => !line.closedShort && leftOf(line) > 0))
    if (chosen.length === 0) issues.push({ path: 'body/lineIds', message: 'Nothing is left to close: every line shipped in full or is closed already.' })
  }
  const seen = new Set<string>()
  lineIds.forEach((lineId, index) => {
    const line = byId.get(lineId)
    const at = `body/lineIds/${index}`
    if (!line) return void issues.push({ path: at, message: 'Not a line of this order.' })
    if (seen.has(lineId)) return void issues.push({ path: at, message: 'This line is named twice.' })
    seen.add(lineId)
    if (line.closedShort) return void issues.push({ path: at, message: `${lineWord(line.seq)} is closed short already.` })
    if (leftOf(line) === 0) return void issues.push({ path: at, message: `${lineWord(line.seq)} shipped in full: nothing is left to close.` })
    chosen.push(line)
  })
  if (issues.length > 0) return issues
  const closing = new Set(chosen.map((line) => line.id))
  const anyShipped = lines.some((line) => line.shipped > 0)
  const after = lines.map((line) => ({ ...line, closedShort: line.closedShort || closing.has(line.id) }))
  if (!anyShipped && after.every((line) => line.closedShort)) return [{ path: 'body/lineIds', message: 'Nothing has shipped: closing every line would leave an empty order. Cancel the order instead.' }]
  return {
    close: chosen.sort((a, b) => a.seq - b.seq).map((line) => ({ id: line.id, seq: line.seq, closedShortQuantity: leftOf(line) })),
    done: anyShipped && after.every((line) => line.closedShort || leftOf(line) === 0),
  }
}

/** What "Reopen lines" reopens: the closed lines named (none: every closed line). */
export function reopenPlan(status: SalesOrderStatus, lines: readonly ShortLine[], lineIds: readonly string[]): { readonly reopen: readonly string[] } | Issue[] {
  if (!REOPEN_STATUSES.includes(status)) return [{ path: 'body', message: `The order is ${status}: its closed lines stay closed.` }]
  const byId = new Map(lines.map((line) => [line.id, line]))
  if (lineIds.length === 0) {
    const closed = lines.filter((line) => line.closedShort).map((line) => line.id)
    return closed.length > 0 ? { reopen: closed } : [{ path: 'body/lineIds', message: 'No line is closed short.' }]
  }
  const issues: Issue[] = []
  const seen = new Set<string>()
  lineIds.forEach((lineId, index) => {
    const line = byId.get(lineId)
    const at = `body/lineIds/${index}`
    if (!line) return void issues.push({ path: at, message: 'Not a line of this order.' })
    if (seen.has(lineId)) return void issues.push({ path: at, message: 'This line is named twice.' })
    seen.add(lineId)
    if (!line.closedShort) issues.push({ path: at, message: `${lineWord(line.seq)} is not closed short.` })
  })
  return issues.length > 0 ? issues : { reopen: [...seen] }
}

// ---- the cancel's impact check -----------------------------------------------------------------------------------------

export const IMPACT_CODES = [
  // what stops the cancellation
  'STATE',
  'DRAFT_WORK_ORDERS',
  'SHIPMENT_IN_PREPARATION',
  'SHIPPED',
  'INVOICE_DRAFT',
  'INVOICE_ISSUED',
  // what it changes
  'DEPOSITS_CANCELLED',
  'PAYMENT_STEPS_CANCELLED',
  // what it leaves behind
  'WORK_ORDERS_OPEN',
  'LEATHER_CUT',
  'STOCK_RESERVED',
  'PURCHASE_ORDERS',
  'DEPOSIT_PAID',
  'PAYMENT_STEPS_PAID',
] as const
export type ImpactCode = (typeof IMPACT_CODES)[number]

export interface ImpactRef {
  /** The record's type, as record links name it (WorkOrder, Shipment, Invoice, DepositRequest, …). */
  readonly type: string
  readonly id: string
  readonly number: string | null
}

export interface ImpactItem {
  readonly code: ImpactCode
  /** In words, without an amount. */
  readonly message: string
  readonly refs: readonly ImpactRef[]
  /** The money it is about (price grain), when it is about money: VAT included, minor units. */
  readonly amount: MinorUnits | null
}

export interface CancelFacts {
  readonly status: SalesOrderStatus
  /** The work orders of its lines (repairs left out), with the leather cut for them (hides, area in the base unit). */
  readonly workOrders: readonly { readonly id: string; readonly number: string; readonly status: string; readonly cutHides: number; readonly cutArea: string | null }[]
  readonly shipments: readonly { readonly id: string; readonly number: string; readonly status: string }[]
  readonly invoices: readonly { readonly id: string; readonly number: string | null; readonly docType: string; readonly status: string }[]
  readonly deposits: readonly { readonly id: string; readonly status: string; readonly amount: MinorUnits }[]
  readonly milestones: readonly { readonly id: string; readonly kind: string; readonly status: string; readonly amount: MinorUnits }[]
  /** ACTIVE reservations held for its lines or its work orders. */
  readonly reservations: readonly { readonly id: string }[]
  /** Open purchase orders the latest planning counted on for its lines. */
  readonly purchaseOrders: readonly { readonly id: string; readonly number: string }[]
}

export interface CancelImpact {
  readonly cancellable: boolean
  readonly blocks: readonly ImpactItem[]
  readonly touches: readonly ImpactItem[]
  readonly leavesBehind: readonly ImpactItem[]
}

const OPEN_WORK_ORDERS = new Set(['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'])
const PREPARING = new Set(['DRAFT', 'PACKED'])
const LEFT = new Set(['SHIPPED', 'DELIVERED'])
const numbers = (refs: readonly ImpactRef[]): string => refs.map((ref) => ref.number ?? ref.id).join(', ')
const total = (rows: readonly { readonly amount: MinorUnits }[]): MinorUnits => rows.reduce((sum, row) => sum + row.amount, 0)

/** What a cancellation of the order would stop at, change and leave behind (the design's Cancel order dialog). */
export function cancelImpact(facts: CancelFacts): CancelImpact {
  const blocks: ImpactItem[] = []
  const touches: ImpactItem[] = []
  const leavesBehind: ImpactItem[] = []
  const item = (code: ImpactCode, message: string, refs: ImpactRef[], amount: MinorUnits | null = null): ImpactItem => ({ code, message, refs, amount })

  if (!CANCEL_STATUSES.includes(facts.status)) {
    const why = FINAL_STATUSES.includes(facts.status) ? `The order is ${facts.status}: it never changes.` : `The order is ${facts.status}: goods left, so it is no longer cancelled (a return or a credit note is the way back).`
    blocks.push(item('STATE', why, []))
  }
  const drafts = facts.workOrders.filter((row) => row.status === 'DRAFT').map((row) => ({ type: 'WorkOrder', id: row.id, number: row.number }))
  if (drafts.length > 0) blocks.push(item('DRAFT_WORK_ORDERS', `Its draft work orders are cancelled first (${numbers(drafts)}), so none is released for a cancelled order.`, drafts))
  const preparing = facts.shipments.filter((row) => PREPARING.has(row.status)).map((row) => ({ type: 'Shipment', id: row.id, number: row.number }))
  if (preparing.length > 0) blocks.push(item('SHIPMENT_IN_PREPARATION', `Shipments being packed for it are cancelled first in the warehouse (${numbers(preparing)}).`, preparing))
  const left = facts.shipments.filter((row) => LEFT.has(row.status)).map((row) => ({ type: 'Shipment', id: row.id, number: row.number }))
  if (left.length > 0 && CANCEL_STATUSES.includes(facts.status)) blocks.push(item('SHIPPED', `Goods left with ${numbers(left)}: a shipped order is not cancelled (a return is the way back).`, left))
  const goodsInvoices = facts.invoices.filter((row) => row.docType !== 'TD02')
  const draftInvoices = goodsInvoices.filter((row) => row.status === 'DRAFT').map((row) => ({ type: 'Invoice', id: row.id, number: row.number }))
  if (draftInvoices.length > 0) blocks.push(item('INVOICE_DRAFT', `Draft invoices of the order are removed first in Finance (${draftInvoices.length}).`, draftInvoices))
  const issued = goodsInvoices.filter((row) => row.status !== 'DRAFT').map((row) => ({ type: 'Invoice', id: row.id, number: row.number }))
  if (issued.length > 0) blocks.push(item('INVOICE_ISSUED', `Invoices of the order were issued (${numbers(issued)}): a fiscal document is never deleted; Finance issues a credit note first.`, issued))

  const openDeposits = facts.deposits.filter((row) => row.status === 'OPEN')
  if (openDeposits.length > 0) touches.push(item('DEPOSITS_CANCELLED', 'The deposit not paid yet is cancelled with the order: the customer is no longer asked for it.', openDeposits.map((row) => ({ type: 'DepositRequest', id: row.id, number: null })), total(openDeposits)))
  const openSteps = facts.milestones.filter((row) => row.status === 'OPEN')
  if (openSteps.length > 0) touches.push(item('PAYMENT_STEPS_CANCELLED', `${openSteps.length} open step(s) of the payment schedule are cancelled.`, openSteps.map((row) => ({ type: 'SalesOrderMilestone', id: row.id, number: null })), total(openSteps)))

  const open = facts.workOrders.filter((row) => OPEN_WORK_ORDERS.has(row.status)).map((row) => ({ type: 'WorkOrder', id: row.id, number: row.number }))
  if (open.length > 0) leavesBehind.push(item('WORK_ORDERS_OPEN', `Work orders stay open (${numbers(open)}): Production finishes them into stock or cancels them.`, open))
  const cut = facts.workOrders.filter((row) => row.cutHides > 0)
  if (cut.length > 0) {
    const hides = cut.reduce((sum, row) => sum + row.cutHides, 0)
    leavesBehind.push(item('LEATHER_CUT', `Leather was already cut for it: ${hides} hide(s) on ${numbers(cut.map((row) => ({ type: 'WorkOrder', id: row.id, number: row.number })))}.`, cut.map((row) => ({ type: 'WorkOrder', id: row.id, number: row.number }))))
  }
  if (facts.reservations.length > 0) leavesBehind.push(item('STOCK_RESERVED', `${facts.reservations.length} reservation(s) of stock stay until the planner releases them.`, facts.reservations.map((row) => ({ type: 'Reservation', id: row.id, number: null }))))
  if (facts.purchaseOrders.length > 0) {
    const refs = facts.purchaseOrders.map((row) => ({ type: 'PurchaseOrder', id: row.id, number: row.number }))
    leavesBehind.push(item('PURCHASE_ORDERS', `Planning counted on purchase orders for it (${numbers(refs)}): they stay open; the buyer decides.`, refs))
  }
  const paid = facts.deposits.filter((row) => row.status === 'PAID')
  if (paid.length > 0) {
    const td02 = facts.invoices.filter((row) => row.docType === 'TD02' && row.status !== 'DRAFT').map((row) => ({ type: 'Invoice', id: row.id, number: row.number }))
    const refs = [...paid.map((row) => ({ type: 'DepositRequest', id: row.id, number: null })), ...td02]
    leavesBehind.push(item('DEPOSIT_PAID', `The deposit was paid${td02.length > 0 ? ` and invoiced (${numbers(td02)})` : ''}: it stays; a refund or a credit note is Finance's.`, refs, total(paid)))
  }
  const settled = facts.milestones.filter((row) => row.status === 'PAID' && row.kind !== 'DEPOSIT')
  if (settled.length > 0) leavesBehind.push(item('PAYMENT_STEPS_PAID', `${settled.length} paid step(s) of the payment schedule stay paid: a refund is Finance's.`, settled.map((row) => ({ type: 'SalesOrderMilestone', id: row.id, number: null })), total(settled)))

  return { cancellable: blocks.length === 0, blocks, touches, leavesBehind }
}

/** The blocks of the impact as the machine's missing words (orders.ts SalesOrderFacts.cancelBlocks). */
export const cancelBlocksOf = (impact: CancelImpact): string[] => impact.blocks.filter((block) => block.code !== 'STATE' && block.code !== 'DRAFT_WORK_ORDERS').map((block) => block.message)
