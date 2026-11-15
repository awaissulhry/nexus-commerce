import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { InvoiceDual } from './api'
import { DualApprovalCard, type DualApprovalModel } from './view/DualApprovalCard'

/**
 * SCR-517 — dual approval on a supplier invoice's Approval tab (B-W2b-425; design finance.payables rec:Supplier invoice ›
 * Approval › approve#1 "dual approval above 10,000"), made-up people and amounts only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const FIRST = { id: uid('8888', 1), name: 'Persona Finanza' }
const ME = uid('8888', 3)
const dual = (over: Partial<InvoiceDual> = {}): InvoiceDual => ({ invoiceId: uid('3434', 1), needed: true, threshold: { amount: 1000000, currency: 'EUR', decided: false }, first: null, step: 'FIRST', held: null, ...over })
const model = (value: InvoiceDual | null, over: Partial<DualApprovalModel> = {}): DualApprovalModel => ({ value, problem: null, me: ME, cost: true, ...over })

export const designScreen = defineDesignScreen<DualApprovalModel>({
  screen: 'SCR-517',
  title: 'Finance › Payables › Supplier invoice › Approval: dual approval',
  view: DualApprovalCard,
  cases: [
    { id: 'both', label: 'Above the amount: two people approve', model: model(dual()) },
    { id: 'second', label: 'Approved once: a second person approves now', model: model(dual({ first: { by: FIRST, at: '2026-11-14T08:40:00.000Z', standing: true }, step: 'SECOND' })) },
    { id: 'second-mine', label: 'You gave the first yes: someone else gives the second', model: model(dual({ first: { by: FIRST, at: '2026-11-14T08:40:00.000Z', standing: true }, step: 'SECOND', held: 'SECOND_APPROVER' }), { me: FIRST.id }) },
    { id: 'lapsed', label: 'A first yes lapsed: the invoice changed after it', model: model(dual({ first: { by: FIRST, at: '2026-11-13T16:00:00.000Z', standing: false } })) },
    { id: 'under', label: 'Under the amount: one person approves', model: model(dual({ needed: false, step: 'SINGLE' })) },
    { id: 'no-cost', label: 'Without the cost grain: the amount is not drawn', model: model(dual({ threshold: { currency: 'EUR', decided: false } }), { cost: false }) },
    { id: 'loading', label: 'Loading', model: model(null) },
    { id: 'error', label: 'Could not read', model: model(null, { problem: 'problem.read.internal' }) },
  ],
})
