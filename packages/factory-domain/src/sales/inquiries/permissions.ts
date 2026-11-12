import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305; design sales.inquiries SCR-105), in the sales area.
 * Office only. Each inquiry is checked with can() against its company and, when it is from a customer, that customer (a role
 * limited to some customers sees only their inquiries; a prospect's inquiry reaches every role of the company).
 *
 *   sales.inquiries.view     the inquiries list with its tiles, an inquiry with what is asked, its files and the brand's tech
 *                            pack in force, the mail it came from, the quote it became; the inquiry a quote or an order came
 *                            from; the target price only with the price grain (money.price)
 *   sales.inquiries.manage   type an inquiry (office, phone, fair, a portal request), make one from a mail in Mail to sort
 *                            (also email.triage over the mail), change what is asked while open, match a prospect to a
 *                            customer, give it to someone or take it off, ask the customer for more information and take it
 *                            up again, decline it with the reason, mark it lost; make its quote (also quotes.manage over the
 *                            company and the customer: W1's own check)
 */
export const SALES_INQUIRIES_DEFINITIONS = definePermissions('sales', {
  'inquiries.view': {
    risk: 'read',
    description: 'See inquiries and requests for quotation: who asks, what is asked (styles, sizes and quantities, the wanted date), the mail they came from, their files and the brand tech pack in force, and the quote each became. The target price only with the price grain.',
  },
  'inquiries.manage': {
    risk: 'write',
    description: 'Type inquiries and make them from received mail, change what is asked while open, match a prospect to a customer, assign them, ask the customer for more information, decline them with the reason or mark them lost, and make their quote (with quotes.manage).',
  },
})

export const SALES_INQUIRIES_VIEW = 'sales.inquiries.view' satisfies Permission
export const SALES_INQUIRIES_MANAGE = 'sales.inquiries.manage' satisfies Permission

export const SALES_INQUIRIES_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_INQUIRIES_VIEW, SALES_INQUIRIES_MANAGE])

/**
 * Who holds them (auth/roles/templates; the owner from every(), read-only through the registry): sales takes the requests that
 * arrive every day by mail and phone and answers them with a quote.
 */
export const SALES_INQUIRIES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [SALES_INQUIRIES_VIEW, SALES_INQUIRIES_MANAGE],
})
