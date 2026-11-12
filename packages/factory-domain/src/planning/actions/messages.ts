import type { Decimal } from 'decimal.js'
import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE, type Uom } from '../../product/units/units'
import type { MaterialPegging } from '../mrp/net'

/**
 * Action messages on existing orders (B-W2b-306; PLN-073; design planning.mrp "To make": "Action messages on existing
 * orders: advance, postpone, increase, decrease, cancel"), pure: what each run asks a person to do with an order that
 * already exists, in words, with the numbers its sentence is made from (MrpActionMessage: one row per message, OPEN until a
 * person marks it DONE or IGNORED). Never on a new proposal (the grids show those): NEW is in the schema, never raised.
 *
 *   purchase order line   EXPEDITE   it arrives after a need it would cover (and is not past its date yet): bring it to
 *                                    that need, never before today
 *                         DEFER      nothing needs it until more than DEFER_TOLERANCE_DAYS after it arrives: move it to
 *                                    its first use (a week early is safety, not a move)
 *                         DECREASE   only part of what is still to come is needed
 *                         CANCEL     none of it is needed
 *   firm planned order    EXPEDITE   (the run's line that carries it) dated after a need it covers
 *                         INCREASE   the orders need more than it brings
 *                         DECREASE   / CANCEL  it brings more than (or only what nothing) needs
 *   work order            EXPEDITE   due after the order line it makes
 *                         CANCEL     no open order needs its pieces any more (DRAFT or RELEASED, not started)
 *   subcontract order     EXPEDITE   due back after its work order is due
 *   planned work order    EXPEDITE   a planner protected a due date later than the orders need
 *                         INCREASE   / DECREASE  a planner protected a size run of more or fewer garments than the orders need
 *                         CANCEL     nothing in the plan needs it (it stays: a protected row is never removed by a run)
 *
 * A material kept in stock by a rule (reorder point, min/max, safety stock) gets no DEFER, DECREASE or CANCEL: what the
 * orders do not need is its stock (W2a's rule for EXCESS). No date moves before today (PLN-083). Quantities are in the
 * material's base unit (garments for a planned work order), dates calendar days; never a cost, never a person.
 */

export const MRP_ACTIONS = ['EXPEDITE', 'DEFER', 'CANCEL', 'INCREASE', 'DECREASE', 'NEW'] as const
export type MrpAction = (typeof MRP_ACTIONS)[number]
export const ACTION_STATUSES = ['OPEN', 'DONE', 'IGNORED'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]
/** What a message may be about (MrpActionMessage.recordType; the database's list). */
export const ACTION_RECORD_TYPES = ['PurchaseOrderLine', 'WorkOrder', 'SubcontractOrder', 'PlannedWorkOrder', 'MaterialRequirement'] as const
export type ActionRecordType = (typeof ACTION_RECORD_TYPES)[number]
/** A purchase line that comes at most this many days before its first use is kept as it is (safety, not a move). */
export const DEFER_TOLERANCE_DAYS = 7
/** At most this many messages are decided in one request. */
export const MAX_DECIDE = 200
/** A decision note: at most this many characters (the database's). */
export const MAX_DECISION_NOTE = 2000
/** The decisions a person makes on an OPEN message. */
export const DECISIONS = ['DONE', 'IGNORED'] as const
export type ActionDecision = (typeof DECISIONS)[number]

export type FactValue = string | number | boolean | null
export type ActionFacts = Readonly<Record<string, FactValue>>

/** One message a run raises (before its place and ids). */
export interface ActionDraft {
  readonly recordType: ActionRecordType
  readonly recordId: string
  readonly action: MrpAction
  readonly fromDate: BusinessDate | null
  readonly toDate: BusinessDate | null
  /** Four decimals, in `uom` (with it exactly). */
  readonly fromQuantity: string | null
  readonly toQuantity: string | null
  readonly uom: Uom | null
  readonly message: string
  readonly facts: ActionFacts
}

/** A requirement line of this run, with its netting. */
export interface ActionMaterial {
  /** This run's line (a firm planned order's messages are about it). */
  readonly requirementId: string
  /** "SEED-LTH-01 BLK". */
  readonly label: string
  readonly uom: Uom
  readonly pegging: MaterialPegging
  /** Kept in stock by a rule: no DEFER, DECREASE or CANCEL. */
  readonly keptInStock: boolean
}

/** A purchase order line the netting counted on, as the message names it. */
export interface ActionPurchase {
  readonly purchaseOrderNumber: string
  readonly lineSeq: number
}

/** An open work order of the site that makes order lines. */
export interface ActionWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly dueDate: BusinessDate | null
  /** The earliest date of the open order lines it makes; null: none dated (or none open). */
  readonly neededBy: BusinessDate | null
  /** The order behind that date. */
  readonly neededFor: string | null
  /** Some order line it makes is still open demand. */
  readonly stillNeeded: boolean
  /** Started on the floor (IN_PROGRESS, or anything issued or scanned): never asked to be cancelled. */
  readonly started: boolean
}

/** An open subcontract order of the site. */
export interface ActionSubcontract {
  readonly id: string
  readonly number: string
  readonly workshop: string
  readonly expectedBackDate: BusinessDate | null
  readonly workOrderNumber: string
  /** When its work order is due (else its order lines' date). */
  readonly neededBy: BusinessDate | null
}

/** A planned work order a planner protected fields of, with what the plan would write. */
export interface ActionPlanned {
  readonly id: string
  /** "JKT-01 BLK". */
  readonly label: string
  readonly protectedFields: readonly string[]
  readonly dueDate: BusinessDate
  readonly quantity: number
  /** The plan's due date and garments for its demand; null: the plan has no proposal for it. */
  readonly planDueDate: BusinessDate | null
  readonly planQuantity: number | null
  /** Something in this plan still needs it. */
  readonly needed: boolean
}

export interface ActionInput {
  readonly runDate: BusinessDate
  readonly materials: readonly ActionMaterial[]
  readonly purchaseOf: (purchaseOrderLineId: string) => ActionPurchase | undefined
  readonly workOrders?: readonly ActionWorkOrder[]
  readonly subcontracts?: readonly ActionSubcontract[]
  readonly planned?: readonly ActionPlanned[]
}

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const n = (value: Decimal | string): string => decimalOf(value).toFixed()
const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (a > b ? a : b)
const RECORD_ORDER: Readonly<Record<ActionRecordType, number>> = Object.freeze({ PurchaseOrderLine: 0, MaterialRequirement: 1, SubcontractOrder: 2, WorkOrder: 3, PlannedWorkOrder: 4 })
const ACTION_ORDER: Readonly<Record<MrpAction, number>> = Object.freeze({ EXPEDITE: 0, CANCEL: 1, DECREASE: 2, INCREASE: 3, DEFER: 4, NEW: 5 })

const dateMove = (recordType: ActionRecordType, recordId: string, action: 'EXPEDITE' | 'DEFER', fromDate: BusinessDate, toDate: BusinessDate, message: string, facts: ActionFacts): ActionDraft => ({
  recordType,
  recordId,
  action,
  fromDate,
  toDate,
  fromQuantity: null,
  toQuantity: null,
  uom: null,
  message,
  facts,
})

const quantityMove = (recordType: ActionRecordType, recordId: string, action: 'INCREASE' | 'DECREASE', from: Decimal, to: Decimal, uom: Uom, message: string, facts: ActionFacts): ActionDraft => ({
  recordType,
  recordId,
  action,
  fromDate: null,
  toDate: null,
  fromQuantity: q(from),
  toQuantity: q(to),
  uom,
  message,
  facts,
})

const cancel = (recordType: ActionRecordType, recordId: string, fromDate: BusinessDate | null, quantity: { value: Decimal; uom: Uom } | null, message: string, facts: ActionFacts): ActionDraft => ({
  recordType,
  recordId,
  action: 'CANCEL',
  fromDate,
  toDate: null,
  fromQuantity: quantity ? q(quantity.value) : null,
  toQuantity: null,
  uom: quantity ? quantity.uom : null,
  message,
  facts,
})

/** Everything the run asks about existing orders, in a stable order (record kind, action, words). */
export function actionMessagesOf(input: ActionInput): ActionDraft[] {
  const { runDate } = input
  const out: ActionDraft[] = []
  const seenLine = new Set<string>()
  for (const material of input.materials) {
    const { pegging } = material
    const w = (value: Decimal | string) => `${n(value)} ${material.uom}`
    const walked = pegging.coverage.filter((coverage) => decimalOf(coverage.part.quantity).minus(decimalOf(coverage.part.issued)).gt(0))

    // ---- purchase order lines -------------------------------------------------------------------------------------------
    for (const purchase of pegging.purchases) {
      const lineId = purchase.line.purchaseOrderLineId
      // A line is answered once (a material in one colour is netted once).
      if (seenLine.has(lineId)) continue
      seenLine.add(lineId)
      const facts = input.purchaseOf(lineId)
      const name = facts ? `${facts.purchaseOrderNumber} line ${facts.lineSeq}` : purchase.line.purchaseOrderNumber
      const base = { purchaseOrderNumber: facts?.purchaseOrderNumber ?? purchase.line.purchaseOrderNumber, lineSeq: facts?.lineSeq ?? null, material: material.label, uom: material.uom, supplyDate: purchase.line.dueDate }
      const due = purchase.line.dueDate
      const notCounted = decimalOf(purchase.notCounted)
      const counted = decimalOf(purchase.counted)
      const open = counted.plus(notCounted)
      if (purchase.why === 'TOO_LATE' && notCounted.gt(0) && due > runDate) {
        const waiting = walked.filter((coverage) => decimalOf(coverage.short).gt(0) && coverage.day < due)
        const first = waiting[0]
        if (first) {
          const toDate = later(first.day, runDate)
          if (toDate < due) {
            const quantity = waiting.reduce((sum, coverage) => sum.plus(decimalOf(coverage.short)), ZERO)
            const take = quantity.lt(notCounted) ? quantity : notCounted
            out.push(
              dateMove('PurchaseOrderLine', lineId, 'EXPEDITE', due, toDate, `Expedite ${name} (${material.label}) from ${due} to ${toDate}: ${first.part.orderNumber} needs ${w(take)} of it on ${first.day}.`, {
                ...base,
                needDate: first.day,
                orderNumber: first.part.orderNumber,
                quantity: q(take),
                daysEarlier: daysFrom(toDate, due),
              }),
            )
          }
        }
        continue
      }
      if (material.keptInStock) continue
      if (purchase.why === 'NOT_NEEDED' && notCounted.gt(0)) {
        if (counted.isZero()) {
          out.push(cancel('PurchaseOrderLine', lineId, due, { value: open, uom: material.uom }, `Cancel ${name} (${material.label}, ${w(open)} due ${due}): no order needs it any more.`, { ...base, quantity: q(open) }))
          continue
        }
        out.push(quantityMove('PurchaseOrderLine', lineId, 'DECREASE', open, counted, material.uom, `Decrease ${name} (${material.label}) from ${w(open)} to ${w(counted)}: the orders need only ${w(counted)} of what is still to come.`, { ...base, needed: q(counted), quantity: q(open) }))
      }
      // DEFER: it comes well before its first use (not past its date: a late line is the exception list's).
      if (counted.gt(0) && due >= runDate) {
        const uses = walked.filter((coverage) => coverage.supplies.some((supply) => supply.kind === 'PURCHASE_ORDER' && supply.purchaseOrderLineId === lineId)).map((coverage) => coverage.day).sort()
        const firstUse = uses[0]
        if (firstUse && daysFrom(due, firstUse) > DEFER_TOLERANCE_DAYS) {
          out.push(dateMove('PurchaseOrderLine', lineId, 'DEFER', due, firstUse, `Defer ${name} (${material.label}) from ${due} to ${firstUse}: nothing needs it before ${firstUse}.`, { ...base, firstUse, daysLater: daysFrom(due, firstUse) }))
        }
      }
    }

    // ---- the firm planned order this run's line carries --------------------------------------------------------------------
    const firm = pegging.firm
    if (firm) {
      const record = material.requirementId
      const base = { firm: true, material: material.label, uom: material.uom, supplyDate: firm.date }
      const quantity = decimalOf(firm.baseQuantity)
      if (decimalOf(firm.late).gt(0) && firm.firstLateDay) {
        const toDate = later(firm.firstLateDay, runDate)
        if (toDate < firm.date) {
          const order = walked.find((coverage) => coverage.supplies.some((supply) => supply.kind === 'FIRM' && supply.late))?.part.orderNumber ?? null
          out.push(dateMove('MaterialRequirement', record, 'EXPEDITE', firm.date, toDate, `Expedite the firm planned order of ${material.label} from ${firm.date} to ${toDate}: ${order ?? 'an order'} needs ${w(firm.late)} of it from ${firm.firstLateDay}.`, { ...base, needDate: firm.firstLateDay, orderNumber: order, quantity: firm.late }))
        }
      }
      const uncovered = decimalOf(pegging.uncovered)
      if (uncovered.gt(0)) {
        const to = quantity.plus(uncovered)
        out.push(quantityMove('MaterialRequirement', record, 'INCREASE', quantity, to, material.uom, `Increase the firm planned order of ${material.label} from ${w(quantity)} to ${w(to)}: the orders need ${w(uncovered)} more than it brings.`, { ...base, more: q(uncovered) }))
      } else if (!material.keptInStock && decimalOf(firm.unused).gt(0)) {
        const used = decimalOf(firm.inTime).plus(decimalOf(firm.late))
        if (used.isZero()) out.push(cancel('MaterialRequirement', record, firm.date, { value: quantity, uom: material.uom }, `Cancel the firm planned order of ${material.label} (${w(quantity)} by ${firm.date}): no order needs it any more.`, { ...base, quantity: q(quantity) }))
        else out.push(quantityMove('MaterialRequirement', record, 'DECREASE', quantity, used, material.uom, `Decrease the firm planned order of ${material.label} from ${w(quantity)} to ${w(used)}: the orders need only ${w(used)}.`, { ...base, needed: q(used) }))
      }
    }
  }

  // ---- work orders --------------------------------------------------------------------------------------------------------
  for (const order of input.workOrders ?? []) {
    if (order.dueDate && order.neededBy && order.neededBy < order.dueDate) {
      const toDate = later(order.neededBy, runDate)
      if (toDate < order.dueDate) {
        out.push(dateMove('WorkOrder', order.id, 'EXPEDITE', order.dueDate, toDate, `Expedite ${order.number} from ${order.dueDate} to ${toDate}: ${order.neededFor ?? 'its order'} is due on ${order.neededBy}.`, { workOrderNumber: order.number, needDate: order.neededBy, orderNumber: order.neededFor, daysEarlier: daysFrom(toDate, order.dueDate) }))
      }
    }
    if (!order.stillNeeded && !order.started && (order.status === 'DRAFT' || order.status === 'RELEASED')) {
      out.push(cancel('WorkOrder', order.id, order.dueDate, null, `Cancel ${order.number}: no open order needs its pieces any more.`, { workOrderNumber: order.number, status: order.status }))
    }
  }

  // ---- subcontract orders ---------------------------------------------------------------------------------------------------
  for (const order of input.subcontracts ?? []) {
    if (!order.expectedBackDate || !order.neededBy || order.neededBy >= order.expectedBackDate) continue
    const toDate = later(order.neededBy, runDate)
    if (toDate >= order.expectedBackDate) continue
    out.push(
      dateMove('SubcontractOrder', order.id, 'EXPEDITE', order.expectedBackDate, toDate, `Expedite ${order.number} at ${order.workshop} from ${order.expectedBackDate} to ${toDate}: ${order.workOrderNumber} is due on ${order.neededBy}.`, {
        subcontractOrderNumber: order.number,
        workshop: order.workshop,
        workOrderNumber: order.workOrderNumber,
        needDate: order.neededBy,
        daysEarlier: daysFrom(toDate, order.expectedBackDate),
      }),
    )
  }

  // ---- planned work orders a planner protected ----------------------------------------------------------------------------
  for (const row of input.planned ?? []) {
    const base = { plannedWorkOrder: row.label, protectedFields: row.protectedFields.join(',') }
    if (!row.needed) {
      out.push(cancel('PlannedWorkOrder', row.id, row.dueDate, { value: decimalOf(String(row.quantity)), uom: 'PCS' }, `Cancel planned work order ${row.label} (${row.quantity} garments due ${row.dueDate}): nothing in this plan needs it any more. It stays because fields of it are protected; Reset to plan lets the next run remove it.`, { ...base, quantity: row.quantity }))
      continue
    }
    if (row.protectedFields.includes('dueDate') && row.planDueDate && row.planDueDate < row.dueDate) {
      const toDate = later(row.planDueDate, runDate)
      if (toDate < row.dueDate) out.push(dateMove('PlannedWorkOrder', row.id, 'EXPEDITE', row.dueDate, toDate, `Expedite planned work order ${row.label} from ${row.dueDate} to ${toDate}: you protected its due date, and the orders need it by ${row.planDueDate}.`, { ...base, planDueDate: row.planDueDate }))
    }
    if (row.protectedFields.includes('sizes') && row.planQuantity !== null && row.planQuantity !== row.quantity && row.planQuantity > 0) {
      const action = row.planQuantity > row.quantity ? 'INCREASE' : 'DECREASE'
      out.push(
        quantityMove('PlannedWorkOrder', row.id, action, decimalOf(String(row.quantity)), decimalOf(String(row.planQuantity)), 'PCS', `${action === 'INCREASE' ? 'Increase' : 'Decrease'} planned work order ${row.label} from ${row.quantity} to ${row.planQuantity} garments: you protected its size run, and the orders need ${row.planQuantity}.`, {
          ...base,
          planQuantity: row.planQuantity,
        }),
      )
    }
  }

  return out.sort((a, b) => RECORD_ORDER[a.recordType] - RECORD_ORDER[b.recordType] || ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
}

/** A message a planner IGNORED earlier (the same record and action). */
export interface IgnoredMessage {
  readonly recordType: string
  readonly recordId: string
  readonly action: string
  readonly toDate: BusinessDate | null
  readonly toQuantity: string | null
}

/** Whether a draft asks what a planner ignored before (same record, action and target): it is not raised again. */
export const ignoredBefore = (draft: ActionDraft, ignored: readonly IgnoredMessage[]): boolean =>
  ignored.some((row) => row.recordType === draft.recordType && row.recordId === draft.recordId && row.action === draft.action && row.toDate === draft.toDate && (row.toQuantity === null ? draft.toQuantity === null : draft.toQuantity !== null && decimalOf(row.toQuantity).eq(decimalOf(draft.toQuantity))))

/** Why a message cannot be decided now (null: it can), in words. */
export function decideProblem(message: { readonly status: string }, run: { readonly status: string }): string | null {
  if (message.status !== 'OPEN') return `It is ${message.status.toLowerCase()} already.`
  if (run.status !== 'DONE') return 'A newer plan replaced the one it came from: read its messages instead.'
  return null
}

/** The words of a message's action (the screens say them from `action`). */
export const ACTION_LABELS: Readonly<Record<MrpAction, string>> = Object.freeze({
  EXPEDITE: 'Expedite',
  DEFER: 'Defer',
  CANCEL: 'Cancel',
  INCREASE: 'Increase',
  DECREASE: 'Decrease',
  NEW: 'New',
})
