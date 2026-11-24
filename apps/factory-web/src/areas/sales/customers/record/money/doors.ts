import { recordAddress } from '../../../../../lib/records/record-links'
import { companyPrefix } from '../../../../../lib/session/session'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { receivablesOfCustomer } from '../../money/model'
import { notEqualDoor } from '../use-customer-work'
import { collectAnchor } from './sections'

/**
 * F-CM-101 (customer page › MONEY tab, 10-design §5–§6; 13-backend §4.1, §4.3) — every address the tab opens, in one place. A door
 * leaves with THIS customer (or the document, the order) already chosen; an act that opens a window in place is not here.
 */

const enc = encodeURIComponent

/** The customer's own record (`/w/<company>/sales/customers/<id>`). */
export const customerHref = (prefix: string, partyId: string): string => `${prefix}/sales/customers/${enc(partyId)}`

/** This customer's page at a tab (and a section). */
export const customerTabHref = (prefix: string, partyId: string, tab: string, hash?: string): string => `${customerHref(prefix, partyId)}?tab=${enc(tab)}${hash ? `#${hash}` : ''}`

/** Work › All orders: what each order has paid and still owes, also what is not asked yet (the Paid and Balance columns). */
export const workAllOrdersHref = (prefix: string, partyId: string): string => `${customerHref(prefix, partyId)}?tab=work&rows=all`

/** Work on the open orders: "Not invoiced yet: N orders ›". */
export const workOpenOrdersHref = (prefix: string, partyId: string): string => `${customerHref(prefix, partyId)}?tab=work&rows=open`

/** Work's Not equal view: "Prices differ on N orders ›" (today's own door, F-CP-141). */
export const priceDifferHref = (prefix: string, partyId: string): string => notEqualDoor(customerHref(prefix, partyId))

/** Terms & requirements at the tax identity: "Can't be invoiced yet ›". */
export const termsIdentityHref = (prefix: string, partyId: string): string => customerTabHref(prefix, partyId, 'terms', 'party-identity')

/** An order's Money tab at a part: a request's own row (`about-DepositRequest-<id>`, the plan row's anchor) or its Invoices. */
export const orderMoneyHref = (prefix: string, orderId: string, anchor: string): string => `${prefix}/sales/orders/${enc(orderId)}?tab=money#${anchor}`

/** The anchor of a deposit request's row on its order's Money tab (rec/money/view/PlanRow.tsx: `about-DepositRequest-<id>`). */
export const requestRowAnchor = (requestId: string): string => `about-DepositRequest-${requestId}`

/** Finance's invoice record (its own page; the record panel where none is built). */
export const invoiceHref = (prefix: string, invoice: { readonly id: string; readonly number: string | null }, companyId: string | null): string =>
  `${prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId }, OFFICE_PAGES)}`

/** Finance's Record a payment with ONE invoice chosen — the order page's own door (rec/money/view/PlanRow.tsx). */
export const recordPaymentOnInvoiceHref = (prefix: string, invoiceId: string): string => `${prefix}/finance/payments?new=1&invoice=${enc(invoiceId)}`

/** F-CM-204 (S3): Finance's Record a payment with THIS customer chosen — ONE payment onto several invoices and requests, oldest first. */
export const recordPaymentForCustomerHref = (prefix: string, partyId: string): string => `${prefix}/finance/payments?new=1&party=${enc(partyId)}`

/** Finance › Receivables & credit with this customer chosen (the API's own `partyId`). */
export const receivablesHref = (prefix: string, partyId: string): string => receivablesOfCustomer(prefix, partyId)

/** The same tab of this customer in another company the reader reaches ("Open with Seed Company B ›"): that company's own page. */
export const otherCompanyHref = (companyCode: string, partyId: string): string => `${companyPrefix(companyCode)}/sales/customers/${enc(partyId)}?tab=money`

/** A To-collect row's own address on this tab (Copy link to this row). */
export const collectRowHref = (prefix: string, partyId: string, target: 'DEPOSIT_REQUEST' | 'INVOICE', id: string): string => customerTabHref(prefix, partyId, 'money', collectAnchor(target, id))
