import { COMPANY, CUSTOMER, PARTIES, PAYMENT, TD01_ID, TODAY, at } from '../../../_demo/fixtures'
import type { OpenRefunds, Refund } from '../api'

/**
 * Made-up refunds for B-W2a-80's design cases: the credit note FT-2026-00033 of FT-2026-00031 (61.00 paid back, nothing
 * refunded yet), a refund due of 120.00 to "Esempio Racing S.p.A.", one made and one cancelled, and a payment's credit
 * balance given back. Nothing here is a real company, person, invoice or bank reference. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

const refund = (n: number, over: Partial<Refund>): Refund => ({
  id: uid('4646', n),
  version: 1,
  companyId: COMPANY,
  partyId: PARTIES[1].id,
  party: { code: PARTIES[1].code, legalName: PARTIES[1].name },
  source: 'CREDIT_NOTE',
  creditNote: { id: uid('8181', 40 + n), number: `FT-2026-000${40 + n}`, issueDate: '2026-10-20', creditOfId: uid('8181', 20 + n), creditOfNumber: `FT-2026-000${20 + n}`, creditOfDocType: 'TD01' },
  payment: null,
  method: 'BANK_TRANSFER',
  amount: 12000,
  currency: 'EUR',
  dueDate: '2026-11-05',
  status: 'DUE',
  paidOn: null,
  externalRef: null,
  cancelReason: null,
  voidReason: null,
  internalNote: null,
  createdAt: at(21, 10),
  ...over,
})

export const REFUND_DUE = refund(1, {})
export const REFUND_PAID = refund(2, { status: 'PAID', paidOn: '2026-10-22', dueDate: null, externalRef: 'TRN-ESEMPIO-0002', amount: 4500 })
export const REFUND_CANCELLED = refund(3, { status: 'CANCELLED', cancelReason: 'The customer keeps it for the next order.', amount: 3000 })
export const REFUND_OF_BALANCE = refund(4, { source: 'PAYMENT', creditNote: null, payment: { id: PAYMENT.id, receivedOn: PAYMENT.receivedOn, externalRef: PAYMENT.externalRef }, partyId: PAYMENT.partyId, party: PAYMENT.party, amount: 20000, dueDate: '2026-11-03' })

export const OPEN_REFUNDS: OpenRefunds = {
  counts: { refundsDue: 1, creditNotesToRefund: 1 },
  refundsDue: [REFUND_DUE],
  creditNotesToRefund: [
    {
      creditNoteId: uid('8181', 33),
      number: 'FT-2026-00033',
      issueDate: TODAY,
      companyId: COMPANY,
      partyId: CUSTOMER.id,
      party: { code: CUSTOMER.code, legalName: CUSTOMER.name },
      currency: 'EUR',
      grossTotal: 6100,
      creditOfId: TD01_ID,
      creditOfNumber: 'FT-2026-00031',
      creditOfDocType: 'TD01',
      orderNumber: 'SO-2026-0088',
      refundedAmount: 0,
      refundableAmount: 6100,
    },
  ],
  asOf: at(29, 15, 5),
}

export const REFUNDS_ALL: Refund[] = [REFUND_DUE, REFUND_PAID, REFUND_CANCELLED, REFUND_OF_BALANCE]
