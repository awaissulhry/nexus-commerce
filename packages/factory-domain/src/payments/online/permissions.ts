import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Paying in the customer portal (B-W2b-185; FIN-118, FIN-123; design portal.customer.documents "To pay": "Price grain,
 * finance and customer-admin roles only (open items, amounts due, statement)"). Partner permissions (flagged `partner`:
 * held only by partner roles, never by an office or floor role), given to the customer's Finance role; its Admin follows
 * (../../auth/roles/templates PARTNER_ADDS). Every figure is a price: the routes answer them with the price grain, which
 * Finance and Admin hold.
 *
 *   payments.view   the open items (open invoices and deposit requests, due dates, overdue in words), the statement of
 *                   account and its PDF, how a payment of yours stands
 *   payments.pay    pay an open invoice or deposit request by card or SEPA Direct Debit through the payment provider
 *
 * The office's side needs nothing new: sending the payment page by link is payments.record, reading the intents of a
 * record payments.view (modules/payments). A link session pays with its purpose's grants (PAYMENT, DEPOSIT_INFO).
 */
export const PORTAL_PAYMENTS_DEFINITIONS = definePartnerPermissions('portal', {
  'payments.view': { risk: 'read', description: 'See what your organisation has to pay: open invoices and deposits, due dates and the statement of account.' },
  'payments.pay': { risk: 'write', description: 'Pay an open invoice or deposit online, by card or SEPA Direct Debit, through the payment provider.' },
})

export const PORTAL_PAYMENTS_VIEW = 'portal.payments.view' satisfies Permission
export const PORTAL_PAYMENTS_PAY = 'portal.payments.pay' satisfies Permission
export const PORTAL_PAYMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_PAYMENTS_VIEW, PORTAL_PAYMENTS_PAY])
