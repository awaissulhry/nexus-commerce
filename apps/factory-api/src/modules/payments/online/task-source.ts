import type { TaskSource } from '../../../platform/portal/tasks/sources'

/**
 * B-W2b-185 (FIN-118; plan "a PAY_INVOICE task per open invoice"; design portal.frame action-needed "pay an invoice"): one
 * request to pay per issued TD01 / TD24 invoice while something is open on it, for the customer's Finance and Admin (the
 * kind needs portal.payments.pay and the price grain). sourceKey `PayInvoice:<invoiceId>`. Its answer is the money itself:
 * the payment that leaves nothing open closes it (./tasks.ts), so the partner never marks it done by hand.
 */
export const PAY_INVOICE_SOURCE: TaskSource = Object.freeze<TaskSource>({ name: 'payments.payInvoice', prefix: 'PayInvoice', kinds: ['PAY_INVOICE'], partnerDone: false })

export const payInvoiceKey = (invoiceId: string): string => `PayInvoice:${invoiceId}`
