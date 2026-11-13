import { recordAddress } from '../../../../lib/records/record-links'
import type { SupplyLate, SupplyLateFixes } from './api'

/**
 * Supply too late on Planning › Exceptions (SCR-125; B-W2b-336 on B-W2b-317's API), pure: what a person may do, where each fix
 * opens (a real link: ⌘-click keeps the queue open while fixing) — Chase the purchase order (its record with the chase dialog,
 * B-W2b-333), Move the work order on the board, Buy elsewhere (the material's line in What to buy & make, the other supplier's
 * record), Re-promise the order line (Promise dates with its Re-promise) — and the words come from the catalogue
 * `planning-promise` (`supplyLate.*`).
 */

/** The words of this part live in the Promise dates catalogue (the step's own file). */
export const SUPPLY_LATE_NAMESPACE = 'planning-promise'
export const SUPPLY_LATE_KIND = 'SUPPLY_LATE'

export interface SupplyLateCan {
  /** planning.exceptions.manage: Check now. */
  check: boolean
  /** planning.promise.view: Promise dates opens (the re-promise fix). */
  promise: boolean
  /** planning.promise.manage: a re-promise can be proposed. */
  repromise: boolean
  /** purchasing.view: the purchase order opens (chase). */
  purchasing: boolean
}

export function supplyLateCan(permissions: readonly string[]): SupplyLateCan {
  const has = (name: string) => permissions.includes(name)
  return { check: has('planning.exceptions.manage'), promise: has('planning.promise.view'), repromise: has('planning.promise.manage'), purchasing: has('purchasing.view') }
}

export interface Place {
  readonly prefix: string
  readonly siteId: string | null
  readonly built: ReadonlySet<string>
}

const siteTerm = (place: Place) => (place.siteId ? `site=${encodeURIComponent(place.siteId)}&` : '')

/** The purchase order's record, with its chase dialog open when it has a page of its own. */
export function chaseHref(chase: NonNullable<SupplyLateFixes['chase']>, place: Place): string {
  const address = recordAddress({ type: 'PurchaseOrder', id: chase.purchaseOrder.id, label: chase.purchaseOrder.number }, place.built)
  return `${place.prefix}${address}${address.startsWith('/purchasing/orders/') ? '?chase=1' : ''}`
}

export const boardHref = (workOrderId: string, place: Place): string => `${place.prefix}/planning/board?${siteTerm(place)}wo=${encodeURIComponent(workOrderId)}`

/** The material's line in What to buy & make (a draft purchase order from the plan names it), else the plan. */
export const planHref = (requirementId: string | null, place: Place): string => `${place.prefix}/planning/mrp?${siteTerm(place)}view=all${requirementId ? `&line=${encodeURIComponent(requirementId)}` : ''}`

export const supplierHref = (supplier: { id: string; code: string }, place: Place): string => `${place.prefix}${recordAddress({ type: 'Party', id: supplier.id, label: supplier.code }, place.built)}`

/** Promise dates with the order line's Re-promise open. */
export const repromiseHref = (orderLineId: string, place: Place): string => `${place.prefix}/planning/promise?${siteTerm(place)}repromise=${encodeURIComponent(orderLineId)}`

export const orderHref = (order: { id: string; number: string }, place: Place): string => `${place.prefix}${recordAddress({ type: 'SalesOrder', id: order.id, label: order.number }, place.built)}`

/** Check now is held: the right, a purchase order to check, a check on its way. */
export function checkHeld(row: Pick<SupplyLate, 'fixes' | 'record'>, can: SupplyLateCan, checking: boolean): string | null {
  if (!can.check) return 'supplyLate.held.noCheck'
  if (!purchaseOrderOf(row)) return 'supplyLate.held.noOrder'
  if (checking) return 'supplyLate.held.checking'
  return null
}

/** The purchase order a supply-too-late exception is about (the chase fix, else its record). */
export function purchaseOrderOf(row: Pick<SupplyLate, 'fixes' | 'record'>): string | null {
  return row.fixes?.chase?.purchaseOrder.id ?? (row.record?.type === 'PurchaseOrder' ? row.record.id : null)
}

/** The re-promise fix of an order line: held without Promise dates (or its right), Review when one waits. */
export function repromiseHeld(entry: SupplyLateFixes['repromise'][number], can: SupplyLateCan): { label: 'supplyLate.repromise.verb' | 'supplyLate.repromise.review'; held: string | null } {
  if (!can.promise) return { label: 'supplyLate.repromise.verb', held: 'supplyLate.held.noPromise' }
  if (entry.waiting) return { label: 'supplyLate.repromise.review', held: null }
  if (!can.repromise) return { label: 'supplyLate.repromise.verb', held: 'supplyLate.held.noRepromise' }
  if (!entry.may) return { label: 'supplyLate.repromise.verb', held: 'supplyLate.held.mayNot' }
  return { label: 'supplyLate.repromise.verb', held: null }
}

export const riskTone = (risk: SupplyLateFixes['repromise'][number]['risk']): 'danger' | 'warning' | 'neutral' | 'success' => (risk === 'LATE' ? 'danger' : risk === 'AT_RISK' ? 'warning' : risk === 'ON_TIME' ? 'success' : 'neutral')
