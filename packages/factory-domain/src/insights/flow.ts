import { holds, type Actor, type Permission } from '../core/permissions'
import type { EventType } from '../events/catalogue'
import { INVOICES_VIEW } from '../invoicing/permissions'
import { WORKORDERS_VIEW } from '../production/work-orders/permissions'
import { PURCHASING_VIEW } from '../purchasing/permissions'
import { QUALITY_LOTS_VIEW } from '../quality/lab/permissions'
import { ORDERS_VIEW } from '../sales/orders/permissions'

/**
 * Where the work is (B-W1-52; SCR-031 W1 "Overview", on Today as the role's flow strip; design home.today `flow`): per
 * lens, the records the person can see by stage, how many of them are late, and how old the oldest is. Counts only (no
 * money). A person gets every lens whose records they can see (two roles: a SegmentedControl in the web), in this order.
 * Each stage names the area list's filter that shows its rows: `exact` when the list shows exactly them (the number and
 * the list agree); where no list filter matches a stage (several invoice states, an unpaid invoice, lots: no list route
 * yet), `filter` is null and the web opens the list unfiltered.
 *
 *   ORDERS           Waiting for deposit → Planned → In production → Ready to ship → Partly shipped → Shipped (to close)
 *   WORK_ORDERS      Draft → Released → In progress → Completed (scan stages per operation: W2a)
 *   PURCHASE_ORDERS  Draft → Sent → Changes proposed → Confirmed → Partly received → Received
 *   INVOICES         Draft → To send to SDI → At SDI → Delivered, not paid → Paid
 *   LOTS             In quarantine → Blocked → Released (30 days) → Rejected (30 days)
 *
 * Late: an open order past its promise, a work order past its due date, a purchase order past its requested date with
 * goods still to come; invoices and lots have no date to be late against (null, never 0).
 */

export const FLOW_LENSES = ['ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS', 'INVOICES', 'LOTS'] as const
export type FlowLens = (typeof FLOW_LENSES)[number]

export interface StageRule {
  readonly key: string
  readonly label: string
  /** The area list's query parameters for the stage; null when no list filter matches it. */
  readonly filter: Readonly<Record<string, string>> | null
  /** The filtered list shows exactly the stage's rows (else it shows more: Planned lists every confirmed order). */
  readonly exact: boolean
  /** Whether a row of this stage can be late (it has a date to keep). */
  readonly canBeLate: boolean
}

export interface LensRule {
  readonly lens: FlowLens
  readonly label: string
  readonly view: Permission
  /** The area list the stages filter (its API route); null while the area has no list. */
  readonly list: string | null
  readonly stages: readonly StageRule[]
  readonly live: readonly EventType[]
}

const stage = (key: string, label: string, filter: Record<string, string> | null, canBeLate = true, exact = filter !== null): StageRule =>
  Object.freeze({ key, label, filter: filter === null ? null : Object.freeze(filter), exact, canBeLate })

/** Released or rejected lots are counted over this many days (a count of every lot ever released says nothing). */
export const RECENT_LOT_DAYS = 30

export const LENS_RULES: Readonly<Record<FlowLens, LensRule>> = Object.freeze({
  ORDERS: {
    lens: 'ORDERS',
    label: 'Sales orders',
    view: ORDERS_VIEW,
    list: '/sales/orders',
    stages: [
      stage('WAITING_FOR_DEPOSIT', 'Waiting for deposit', { status: 'CONFIRMED', deposit: 'OPEN' }),
      stage('PLANNED', 'Planned', { status: 'CONFIRMED' }, true, false),
      stage('IN_PRODUCTION', 'In production', { status: 'IN_PRODUCTION' }),
      stage('READY', 'Ready to ship', { status: 'READY' }),
      stage('PARTLY_SHIPPED', 'Partly shipped', { status: 'PARTLY_SHIPPED' }),
      stage('SHIPPED', 'Shipped, to close', { status: 'SHIPPED' }, false),
    ],
    live: ['sales_order.created', 'sales_order.status_changed', 'sales_order.promise_changed', 'deposit_request.created', 'payment.deposit_paid'],
  },
  WORK_ORDERS: {
    lens: 'WORK_ORDERS',
    label: 'Work orders',
    view: WORKORDERS_VIEW,
    list: '/production/work-orders',
    stages: [
      stage('DRAFT', 'Draft', { status: 'DRAFT' }),
      stage('RELEASED', 'Released', { status: 'RELEASED' }),
      stage('IN_PROGRESS', 'In progress', { status: 'IN_PROGRESS' }),
      stage('COMPLETED', 'Completed', { status: 'COMPLETED' }, false),
    ],
    live: ['workorder.created', 'workorder.released', 'workorder.status_changed', 'workorder.changed'],
  },
  PURCHASE_ORDERS: {
    lens: 'PURCHASE_ORDERS',
    label: 'Purchase orders',
    view: PURCHASING_VIEW,
    list: '/purchasing/orders',
    stages: [
      stage('DRAFT', 'Draft', { status: 'DRAFT' }),
      stage('SENT', 'Sent', { status: 'SENT' }),
      stage('CHANGES_PROPOSED', 'Changes proposed', { status: 'CHANGES_PROPOSED' }),
      stage('CONFIRMED', 'Confirmed', { status: 'CONFIRMED' }),
      stage('PARTLY_RECEIVED', 'Partly received', { status: 'PARTLY_RECEIVED' }),
      stage('RECEIVED', 'Received', { status: 'RECEIVED' }, false),
    ],
    live: ['purchase_order.created', 'purchase_order.sent', 'purchase_order.confirmed', 'purchase_order.changes_proposed', 'purchase_order.declined', 'purchase_order.cancelled', 'inventory.receipt_posted', 'inventory.receipt_reversed'],
  },
  INVOICES: {
    lens: 'INVOICES',
    label: 'Invoices',
    view: INVOICES_VIEW,
    list: '/invoicing/invoices',
    stages: [
      stage('DRAFT', 'Draft', { status: 'DRAFT' }, false),
      stage('TO_SEND', 'To send to SDI', null, false),
      stage('AT_SDI', 'At SDI', { status: 'SENT' }, false),
      stage('DELIVERED', 'Delivered, not paid', null, false),
      stage('PAID', 'Paid', null, false),
    ],
    live: ['invoice.draft_saved', 'invoice.draft_deleted', 'invoice.issued', 'invoice.sdi_status_changed', 'payment.allocated', 'payment.allocation_reversed'],
  },
  LOTS: {
    lens: 'LOTS',
    label: 'Lots',
    view: QUALITY_LOTS_VIEW,
    list: null,
    stages: [
      stage('QUARANTINE', 'In quarantine', null, false),
      stage('BLOCKED', 'Blocked', null, false),
      stage('RELEASED', `Released (${RECENT_LOT_DAYS} days)`, null, false),
      stage('REJECTED', `Rejected (${RECENT_LOT_DAYS} days)`, null, false),
    ],
    live: ['inventory.receipt_posted', 'inventory.opening_posted', 'lot.released', 'lot.rejected', 'lot.blocked', 'lot.hold_cleared'],
  },
})

/** The lenses the actor can see records of, in the strip's order. */
export function lensesFor(actor: Actor): FlowLens[] {
  return FLOW_LENSES.filter((lens) => holds(actor, LENS_RULES[lens].view))
}

/** A sales order's stage: CONFIRMED splits by its deposit (an OPEN request of a deposit it needs). Closed and cancelled: none. */
export function orderStageOf(status: string, waitsForDeposit: boolean): string | null {
  if (status === 'CONFIRMED') return waitsForDeposit ? 'WAITING_FOR_DEPOSIT' : 'PLANNED'
  return ['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'].includes(status) ? status : null
}

export function workOrderStageOf(status: string): string | null {
  return ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED'].includes(status) ? status : null
}

export function purchaseOrderStageOf(status: string): string | null {
  return ['DRAFT', 'SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? status : null
}

/** An invoice's stage: delivered splits by whether its payments cover it. */
export function invoiceStageOf(status: string, paid: boolean): string | null {
  if (status === 'DRAFT') return 'DRAFT'
  if (['ISSUED', 'ERROR', 'REJECTED'].includes(status)) return 'TO_SEND'
  if (status === 'SENT') return 'AT_SDI'
  if (status === 'DELIVERED' || status === 'NOT_DELIVERABLE') return paid ? 'PAID' : 'DELIVERED'
  return null
}

export function lotStageOf(qualityStatus: string): string | null {
  return ['QUARANTINE', 'BLOCKED', 'RELEASED', 'REJECTED'].includes(qualityStatus) ? qualityStatus : null
}

export interface StageCount {
  readonly key: string
  readonly label: string
  readonly count: number
  /** Late rows in the stage; null where a stage has no date to be late against. */
  readonly late: number | null
  /** Days since the oldest row of the stage entered the flow; null for an empty stage. */
  readonly oldestDays: number | null
  readonly filter: Readonly<Record<string, string>> | null
  readonly exact: boolean
}

/** One row of a lens, as the API reads it. */
export interface FlowRow {
  readonly stage: string | null
  readonly late: boolean
  /** When it entered the flow (its order date, creation, receipt). */
  readonly since: Date
}

const DAY_MS = 86_400_000

/** The stages of a lens from its rows: every stage is listed (0 is an answer). */
export function stagesOf(lens: FlowLens, rows: readonly FlowRow[], now: Date): StageCount[] {
  return LENS_RULES[lens].stages.map((rule) => {
    const own = rows.filter((row) => row.stage === rule.key)
    const oldest = own.reduce<Date | null>((first, row) => (first === null || row.since < first ? row.since : first), null)
    return {
      key: rule.key,
      label: rule.label,
      count: own.length,
      late: rule.canBeLate ? own.filter((row) => row.late).length : null,
      oldestDays: oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / DAY_MS)),
      filter: rule.filter,
      exact: rule.exact,
    }
  })
}
