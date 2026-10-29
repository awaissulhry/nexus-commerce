import { CERTIFICATES_MANAGE } from '../compliance/certificates/permissions'
import { LABELS_MANAGE } from '../compliance/labels/permissions'
import type { RegisterDuty } from '../compliance/register/rules'
import type { Permission } from '../core/permissions'
import type { BusinessDate } from '../core/time'
import { PRODUCT_BOM_RELEASE } from '../product/bom/permissions'
import { DECLARATIONS_MANAGE } from '../product/compliance/permissions'
import { daysLate, type SalesOrderStatus } from '../sales/orders/orders'
import { daysFrom, type Severity } from './attention'
import { FLOOR_PRIVACY_DUTIES } from './words'

/**
 * When a record needs a person (B-W1-52; ANA-037's fixed late and hold checks): the thresholds and states each source of
 * Today applies to its rows. The records' own rules decide the facts (orders' daysLate, the release check, the SDI
 * deadline, the register's duties, the privacy duties); these say which of them land on Today and how urgent they are.
 */

/** An order due within this many days that is not ready yet is at risk. */
export const AT_RISK_DAYS = 3
/** A purchase order sent this long ago and still not confirmed waits too long. */
export const PO_CONFIRM_HOURS = 48
/** A draft work order due within this many days (or past due) that cannot be released is urgent. */
export const HELD_URGENT_DAYS = 3

/** Orders still being made: a promise near is at risk only while the goods are not ready. */
const AT_RISK_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION'])

export interface PromiseState {
  readonly state: 'LATE' | 'AT_RISK'
  /** Days late, or days left. */
  readonly days: number
  readonly severity: Severity
}

/** A sales order's promise as Today sees it: late (any open order past it), at risk (due within 3 days, not ready), else none. */
export function orderPromiseState(status: SalesOrderStatus, promiseDate: BusinessDate | null, today: BusinessDate): PromiseState | null {
  const late = daysLate(status, promiseDate, today)
  if (late === null || promiseDate === null) return null
  if (late > 0) return { state: 'LATE', days: late, severity: 'HIGH' }
  const left = daysFrom(today, promiseDate)
  return AT_RISK_STATUSES.includes(status) && left <= AT_RISK_DAYS ? { state: 'AT_RISK', days: left, severity: 'MEDIUM' } : null
}

/** A draft the release check holds: urgent when it is due within 3 days or past due. */
export function heldWorkOrderSeverity(dueDate: BusinessDate | null, today: BusinessDate): Severity {
  return dueDate !== null && daysFrom(today, dueDate) <= HELD_URGENT_DAYS ? 'HIGH' : 'MEDIUM'
}

/** Hours since a purchase order was sent, when it waits too long for its confirmation; else null. */
export function hoursUnconfirmed(sentAt: Date | null, now: Date): number | null {
  if (sentAt === null) return null
  const hours = Math.floor((now.getTime() - sentAt.getTime()) / 3_600_000)
  return hours >= PO_CONFIRM_HOURS ? hours : null
}

/** An invoicing deadline's urgency (invoicing/from-shipment/deadlines' states). */
export function deadlineSeverity(state: 'OPEN' | 'DUE_SOON' | 'LATE'): Severity {
  return state === 'LATE' ? 'HIGH' : state === 'DUE_SOON' ? 'MEDIUM' : 'LOW'
}

/** A register entry's duties the law asks now and are not done (compliance/register dutiesOf). */
export const openDuties = (duties: readonly RegisterDuty[]): RegisterDuty['code'][] => duties.filter((duty) => duty.required && !duty.done).map((duty) => duty.code)

/** Urgent when the PPE may present a risk and the authority is not told yet (art. 8(8)). */
export function registerSeverity(open: readonly RegisterDuty['code'][]): Severity {
  return open.includes('AUTHORITY') ? 'HIGH' : 'MEDIUM'
}

/** Urgent when a missing duty keeps the floor off (the worker notice, the DPIA). */
export function privacySeverity(open: readonly string[]): Severity {
  return open.some((duty) => FLOOR_PRIVACY_DUTIES.includes(duty)) ? 'HIGH' : 'MEDIUM'
}

/** Who acts on each of a style's compliance blockers (product/compliance COMPLIANCE_CHECKS). */
export const COMPLIANCE_CHECK_ACT: Readonly<Record<string, Permission>> = Object.freeze({
  REVISION: PRODUCT_BOM_RELEASE,
  LABEL_TEMPLATE: LABELS_MANAGE,
  CERTIFICATE: CERTIFICATES_MANAGE,
  DECLARATION_OF_CONFORMITY: DECLARATIONS_MANAGE,
  USER_INFORMATION: DECLARATIONS_MANAGE,
})

/** The permissions that act on these blockers, without repeats, in the kind's order. */
export function complianceActs(checks: readonly string[], order: readonly Permission[]): Permission[] {
  const wanted = new Set(checks.flatMap((check) => (COMPLIANCE_CHECK_ACT[check] ? [COMPLIANCE_CHECK_ACT[check]] : [])))
  return order.filter((permission) => wanted.has(permission))
}
