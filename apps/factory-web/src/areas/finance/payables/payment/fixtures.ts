import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { InvoiceBatch } from './model'
import { PaymentBatchCard, type PaymentBatchModel } from './view/PaymentBatchCard'

/**
 * SCR-518 — a supplier invoice's payment section (B-W2b-425; design finance.payables rec:Supplier invoice › Payment › pay "in
 * batch of week 46, IBAN used (masked, usable check)"), made-up data only; an account is always masked.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const BATCH: InvoiceBatch = {
  proposal: { id: uid('3737', 1), week: 46, weekStart: '2026-11-09', weekEnd: '2026-11-15', status: 'APPROVED', paidAt: null, currency: 'EUR' },
  line: { id: uid('3636', 1), invoice: { id: uid('3434', 2), number: 'AP-118', issueDate: '2026-10-12', dueDate: '2026-11-12', due: 'THIS_WEEK', status: 'APPROVED', grossTotal: 215050, withholdingAmount: 0 }, supplier: { id: uid('2323', 2), code: 'F-0202', name: 'Accessori Prova Spa' }, amount: 210749, discountAmount: 4301, account: { id: uid('3535', 2), masked: 'IT** **** **** 3310', usable: true }, held: false, problems: [], version: 1 },
}
const model = (over: Partial<PaymentBatchModel> = {}): PaymentBatchModel => ({ prefix: '/w/ALFA', batch: BATCH, more: false, problem: null, cost: true, ...over })

export const designScreen = defineDesignScreen<PaymentBatchModel>({
  screen: 'SCR-518',
  title: 'Finance › Payables › Supplier invoice › Payment: the payment batch',
  view: PaymentBatchCard,
  cases: [
    { id: 'in-batch', label: 'In the batch of week 46, the account usable', model: model() },
    { id: 'paid', label: 'Paid with the batch', model: model({ batch: { ...BATCH, proposal: { ...BATCH.proposal, status: 'PAID', paidAt: '2026-11-14T11:00:00.000Z' } } }) },
    { id: 'held', label: 'Held: no usable account', model: model({ batch: { ...BATCH, proposal: { ...BATCH.proposal, status: 'DRAFT' }, line: { ...BATCH.line, account: null, held: true, problems: ['HELD'] } } }) },
    { id: 'none', label: 'Not in a payment batch yet', model: model({ batch: null }) },
    { id: 'none-older', label: 'Not in the latest batches read', model: model({ batch: null, more: true }) },
    { id: 'no-cost', label: 'Without the cost grain', model: model({ cost: false, batch: { ...BATCH, line: { ...BATCH.line, amount: undefined, discountAmount: undefined } } }) },
    { id: 'loading', label: 'Loading', model: model({ batch: undefined }) },
    { id: 'error', label: 'Could not read', model: model({ batch: undefined, problem: 'problem.read.unavailable' }) },
  ],
})
