import { daysBetween } from '../../alerts/rules'
import type { BusinessDate } from '../../core/time'
import { OPEN_STATUSES, type SalesOrderStatus } from './orders'

/**
 * The later columns of Sales › Orders and the overall view's figures, as pure rules (B-TH-058 / B-TH-059; threads plan TH-4;
 * features SHEET.overall-F02/F03/F11, O-SAL-ORD-LIST.grid-F16/F17, O-SAL-ORD-LIST.tiles-F05; gaps SHEET-G08, N23, ORD-G08).
 * The API reads the rows (modules/sales/orders/later-columns.ts, summary.ts) and asks these, so the row, the overall view's
 * totals and the file say the same number.
 *
 *   open pieces  an order not shipped yet (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED) still owes its pieces less those
 *                closed short and those that left; a shipped, closed or cancelled order owes none.
 *   at risk      the ORDER_LATE_RISK alert rule's own reading (platform/alerts/evaluators.ts), never a second rule: an order
 *                still being made (CONFIRMED, IN_PRODUCTION) promised within the rule's days, the promise not passed yet. A
 *                passed promise is "late" (daysLate), not "at risk". No enabled rule for the order's company: never at risk.
 *   paid         the money received for the order: payments placed on its deposit requests, plus its share of what is placed on
 *                the issued invoices that bill it (TD01, TD24, TD05; all of it when an invoice bills this order only; an
 *                invoice that bills several orders, a monthly TD24, splits by the net each order's lines carry on it), less
 *                the PAID refunds of their credit notes (and of its deposit invoices' credit notes). Reversals are negative
 *                allocations, so they count.
 *   balance      what is still to pay: the order's gross (VAT included, as amended) less what will never be billed (pieces
 *                closed short, a fee credited against the customer's bulk order), less its share of the credit notes of its
 *                invoices, less `paid`; never below 0. A charge billed only on an invoice (freight) is not in the order, so
 *                its payment can bring the balance to 0 early, never below.
 *   shares       integer minor units, rounded half away from zero, exact (BigInt): no float ever touches an amount.
 */

// ---- open pieces -----------------------------------------------------------------------------------------------------------

/** The pieces an order still owes: open orders only, its pieces less those closed short and those that left. */
export function openUnitsOf(status: SalesOrderStatus, ordered: number, closedShort: number, shipped: number): number {
  if (!OPEN_STATUSES.includes(status)) return 0
  return Math.max(0, ordered - closedShort - shipped)
}

// ---- at risk ---------------------------------------------------------------------------------------------------------------

/** The states in which ORDER_LATE_RISK calls a not-yet-late order "at risk": still being made (W1's rule). */
export const AT_RISK_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION'])

export interface AtRisk {
  /** Days left until the promise (0: promised today). */
  readonly daysLeft: number
  /** The rule's threshold for the order's company. */
  readonly daysBeforePromise: number
}

/** At risk under a threshold (null: no enabled rule for the order's company): promised within it, not passed, still being made. */
export function atRiskOf(status: SalesOrderStatus, promiseDate: BusinessDate | null, today: BusinessDate, daysBeforePromise: number | null): AtRisk | null {
  if (daysBeforePromise === null || promiseDate === null || !AT_RISK_STATUSES.includes(status)) return null
  const daysLeft = daysBetween(today, promiseDate)
  return daysLeft >= 0 && daysLeft <= daysBeforePromise ? { daysLeft, daysBeforePromise } : null
}

/**
 * The threshold of each company from the enabled ORDER_LATE_RISK rules: a rule of the company or of every company (companyId
 * null; its site does not matter: the rule reads orders by company only) covers it, and a record any covering rule finds is
 * flagged, so the widest covering threshold counts. Null: no enabled rule covers the company.
 */
export function riskDaysFor(rules: readonly { readonly companyId: string | null; readonly daysBeforePromise: number }[], companyId: string): number | null {
  let days: number | null = null
  for (const rule of rules) if (rule.companyId === null || rule.companyId === companyId) days = Math.max(days ?? 0, rule.daysBeforePromise)
  return days
}

// ---- paid and balance ------------------------------------------------------------------------------------------------------

/** `amount × part / whole` in minor units, rounded half away from zero, exactly (0 when the whole is 0). */
export function shareOf(amount: number, part: number, whole: number): number {
  if (whole === 0 || part === 0 || amount === 0) return 0
  if (part === whole) return amount
  const negative = amount < 0 !== whole < 0 !== part < 0
  const numerator = BigInt(Math.abs(amount)) * BigInt(Math.abs(part))
  const denominator = BigInt(Math.abs(whole))
  const rounded = (numerator * 2n + denominator) / (denominator * 2n)
  const value = Number(rounded)
  return negative ? -value : value
}

export interface OrderMoneyLine {
  readonly quantity: number
  /** Pieces closed short (null: the line is open). */
  readonly closedShortQuantity: number | null
  /** Minor units, as on the line (its price basis). */
  readonly netAmount: number
  readonly vatAmount: number
  /** A fee credited against the customer's bulk order: settled there, never billed here. */
  readonly feeCredited: boolean
}

export interface OrderMoneyInvoice {
  /** What is placed on it (allocations less their reversals). */
  readonly placed: number
  /** The gross of its issued credit notes. */
  readonly creditedGross: number
  /** The PAID refunds of its credit notes. */
  readonly refunded: number
  /** This order's share of it: the net of this order's lines on it over the net of every order line it bills. */
  readonly part: number
  readonly whole: number
}

export interface OrderMoneyFacts {
  /** The order's gross total, as amended. */
  readonly grossAmount: number
  readonly lines: readonly OrderMoneyLine[]
  /** Placed on its deposit requests (allocations less their reversals). */
  readonly depositPlaced: number
  /** The PAID refunds of its deposit invoices' credit notes. */
  readonly depositRefunded: number
  readonly invoices: readonly OrderMoneyInvoice[]
}

export interface OrderMoney {
  readonly paid: number
  readonly balance: number
}

/** The order's gross that will never be billed: pieces closed short (their share of the line's gross) and credited fees. */
export function neverBilledOf(lines: readonly OrderMoneyLine[]): number {
  return lines.reduce((sum, line) => {
    const gross = line.netAmount + line.vatAmount
    if (line.feeCredited) return sum + gross
    if (line.closedShortQuantity === null || line.closedShortQuantity <= 0 || line.quantity <= 0) return sum
    return sum + shareOf(gross, Math.min(line.closedShortQuantity, line.quantity), line.quantity)
  }, 0)
}

/** Paid and balance of an order (see the header). */
export function orderMoneyOf(facts: OrderMoneyFacts): OrderMoney {
  const paid = facts.depositPlaced - facts.depositRefunded + facts.invoices.reduce((sum, invoice) => sum + shareOf(invoice.placed - invoice.refunded, invoice.part, invoice.whole), 0)
  const credited = facts.invoices.reduce((sum, invoice) => sum + shareOf(invoice.creditedGross, invoice.part, invoice.whole), 0)
  const due = facts.grossAmount - neverBilledOf(facts.lines) - credited
  return { paid, balance: Math.max(0, due - paid) }
}
