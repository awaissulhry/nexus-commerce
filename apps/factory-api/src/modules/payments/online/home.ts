import type { HomeSource } from '../../../platform/portal/home/sources'
import { openInvoiceCounts } from './portal'

/**
 * B-W2b-185 (FIN-118; design portal.customer.home "five tiles … invoices due"): the customer's open invoices and the late
 * ones, for Finance and Admin (portal.payments.view with the price grain); null for anyone else ("shows nothing, never 0").
 * Counts only: the amount due is on the To pay list, with its grain.
 */
export const PAYMENT_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'payments',
  counts: [
    { key: 'invoices.to_pay', area: 'documents', kinds: ['CUSTOMER'], words: { it: 'Fatture da pagare', en: 'Invoices to pay' } },
    { key: 'invoices.overdue', area: 'documents', kinds: ['CUSTOMER'], words: { it: 'Fatture scadute', en: 'Overdue invoices' } },
  ],
  async read(_app, request, now) {
    const counts = await openInvoiceCounts(request, now)
    return { 'invoices.to_pay': counts?.toPay ?? null, 'invoices.overdue': counts?.overdue ?? null }
  },
})
