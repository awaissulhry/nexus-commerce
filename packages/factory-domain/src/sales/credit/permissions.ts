import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Credit limits (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244; design finance.receivables sec:credit), in the sales area.
 * Office only. Each check and limit is a customer's with one company: can() over that company and customer. Every amount
 * needs the price grain besides (money.price): without it the reading shows its findings, never a figure.
 *
 *   sales.credit.view     a customer's credit with a company (limit, used, available, overdue, the orders held), the checks a
 *                         quote, an order, a work order or a shipment had, Finance › Receivables › Credit limits; the
 *                         approval kind CREDIT_OVERRIDE's own view (who may see a request beside approvals.view)
 *   sales.credit.limits   set, change or clear a customer's credit limit with a company (logged; the held orders are
 *                         checked again at once)
 *   sales.credit.checks   check a held record again (after a payment), and ask for a yes on a credit hold (a
 *                         CREDIT_OVERRIDE request; the yes is the approver's, never the asker's)
 */
export const SALES_CREDIT_DEFINITIONS = definePermissions('sales', {
  'credit.view': {
    risk: 'read',
    description: "See a customer's credit with a company: the limit, what is used (open orders and invoices), what is still available, the overdue part, the orders held for credit, and the credit checks of quotes, orders, work orders and shipments. The amounts only with the price grain.",
  },
  'credit.limits': {
    risk: 'write',
    description: "Set, change or clear a customer's credit limit with a company; the orders held for credit are checked again at once.",
  },
  'credit.checks': {
    risk: 'write',
    description: 'Check a record held for credit again (after a payment, a raised limit), and ask for a yes to let it through (a credit override someone else approves).',
  },
})

export const SALES_CREDIT_VIEW = 'sales.credit.view' satisfies Permission
export const SALES_CREDIT_LIMITS = 'sales.credit.limits' satisfies Permission
export const SALES_CREDIT_CHECKS = 'sales.credit.checks' satisfies Permission

export const SALES_CREDIT_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_CREDIT_VIEW, SALES_CREDIT_LIMITS, SALES_CREDIT_CHECKS])

/**
 * Who holds them (auth/roles/templates; the owner from every(), read-only through the registry): finance keeps the limits
 * (design finance.receivables "Change limit"), sales reads the credit of its customers and asks for a yes when an order of
 * theirs is held.
 */
export const SALES_CREDIT_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [SALES_CREDIT_VIEW, SALES_CREDIT_LIMITS, SALES_CREDIT_CHECKS],
  sales: [SALES_CREDIT_VIEW, SALES_CREDIT_CHECKS],
})
