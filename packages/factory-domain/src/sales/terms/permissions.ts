import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The payment terms library (B-W2a-19; FIN-075; apps/factory-api modules/sales/terms; design finance.settings "Payment
 * terms"), in its own area. Checked with can() against the terms' company; terms of every company (no company) are
 * changed only by a grant over every company. Office only. No money in the library (shares and days only).
 *
 *   view    the library: the printed names, the payment method, the instalments, the early-payment discount, how many
 *           customers have them as their default; picking them for a customer or a quote needs it
 *   manage  add terms, edit them (a document keeps its own copy: an edit never rewrites one), archive and reactivate
 *
 * A customer's commercial terms (its terms, price list, deposit, invoicing, Incoterms, carrier, minimum order) are kept
 * with parties.manage on the customer (modules/parties commercial-terms.ts); giving it terms needs view here, giving it a
 * price list pricelists.manage.
 */
export const PAYMENT_TERMS_DEFINITIONS = definePermissions('paymentterms', {
  view: { risk: 'read', description: 'See the payment terms library: printed names, payment method, instalments and early-payment discount, and how many customers use each.' },
  manage: { risk: 'write', description: 'Add payment terms to the library and edit them (documents already made keep their own copy); archive and reactivate them.' },
})

export const PAYMENT_TERMS_VIEW = 'paymentterms.view' satisfies Permission
export const PAYMENT_TERMS_MANAGE = 'paymentterms.manage' satisfies Permission
export const PAYMENT_TERMS_PERMISSIONS: readonly Permission[] = Object.freeze([PAYMENT_TERMS_VIEW, PAYMENT_TERMS_MANAGE])
