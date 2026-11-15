import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { scoped } from '../../payments/riba/depth'
import type { Proposal, ProposalCandidates, ProposalLine, ProposalRow } from './api'
import { proposalCanOf } from './model'
import { ProposalDialog, type ProposalDialogModel } from './view/ProposalDialog'

/**
 * SCR-515 — the payment proposal (B-W2b-425, design finance.payables pop:proposal "Payment proposal — week 46"), made-up data
 * only: invented suppliers and invoices, accounts masked (no IBAN is ever drawn). The week's invoices, a draft, the four eyes,
 * dual approval above the amount, recording the transfers made.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const TODAY = '2026-11-14'
const S1 = { id: uid('2323', 1), code: 'F-0201', name: 'Conceria Esempio Srl' }
const S2 = { id: uid('2323', 2), code: 'F-0202', name: 'Accessori Prova Spa' }
const S3 = { id: uid('2323', 3), code: 'F-0203', name: 'Trasporti Finti Srl' }
const MAKER = { id: uid('8888', 2), name: 'Persona Contabile' }
const APPROVER = { id: uid('8888', 1), name: 'Persona Finanza' }
const FINANCE = proposalCanOf(['payables.view', 'payables.proposals.manage', 'payables.proposals.approve', 'payables.pay', 'money.cost'])
const READER = proposalCanOf(['payables.view'])

const CANDIDATES: ProposalCandidates = {
  companyId: uid('1111', 1),
  weekStart: '2026-11-09',
  weekEnd: '2026-11-15',
  week: 46,
  currency: 'EUR',
  items: [
    { invoiceId: uid('3434', 1), number: '2026/0398', supplier: S1, issueDate: '2026-10-05', dueDate: '2026-11-04', due: 'OVERDUE', grossTotal: 732000, payable: 732000, account: { id: uid('3535', 1), masked: 'IT** **** **** 7002', usable: true }, held: false, inProposal: null },
    { invoiceId: uid('3434', 2), number: 'AP-118', supplier: S2, issueDate: '2026-10-12', dueDate: '2026-11-12', due: 'THIS_WEEK', grossTotal: 215050, payable: 215050, account: { id: uid('3535', 2), masked: 'IT** **** **** 3310', usable: true }, held: false, inProposal: null },
    { invoiceId: uid('3434', 3), number: 'TF-77', supplier: S3, issueDate: '2026-10-14', dueDate: '2026-11-14', due: 'THIS_WEEK', grossTotal: 48000, payable: 46000, account: null, held: true, inProposal: null },
  ],
  waiting: [{ invoiceId: uid('3434', 4), number: '2026/0412', supplier: S1, dueDate: '2026-11-13', due: 'THIS_WEEK', status: 'RECEIVED' }],
  totals: { invoices: 3, held: 1, payable: 947050 },
}

const line = (n: number, supplier: typeof S1, number: string, amount: number, over: Partial<ProposalLine> = {}): ProposalLine => ({
  id: uid('3636', n),
  invoice: { id: uid('3434', n), number, issueDate: '2026-10-05', dueDate: '2026-11-12', due: 'THIS_WEEK', status: 'APPROVED', grossTotal: amount, withholdingAmount: 0 },
  supplier,
  amount,
  discountAmount: 0,
  account: { id: uid('3535', n), masked: 'IT** **** **** 7002', usable: true },
  held: false,
  problems: [],
  version: 1,
  ...over,
})

const DRAFT: Proposal = {
  id: uid('3737', 1),
  companyId: uid('1111', 1),
  weekStart: '2026-11-09',
  weekEnd: '2026-11-15',
  week: 46,
  currency: 'EUR',
  status: 'DRAFT',
  note: null,
  createdBy: MAKER,
  createdAt: '2026-11-13T15:00:00.000Z',
  approvedBy: null,
  approvedAt: null,
  paidAt: null,
  cancelledAt: null,
  cancelReason: null,
  lines: [line(1, S1, '2026/0398', 732000, { invoice: { id: uid('3434', 1), number: '2026/0398', issueDate: '2026-10-05', dueDate: '2026-11-04', due: 'OVERDUE', status: 'APPROVED', grossTotal: 732000, withholdingAmount: 0 } }), line(2, S2, 'AP-118', 210749, { discountAmount: 4301, account: { id: uid('3535', 2), masked: 'IT** **** **** 3310', usable: true } })],
  totals: { amount: 942749, discount: 4301, lines: 2, held: 0, suppliers: 2 },
  approval: { dual: { needed: false, threshold: 1000000, decided: false, first: null } },
  remittance: { on: false, source: 'NONE' },
  may: { change: null, approve: null, sendBack: 'NOT_APPROVED', cancel: null, pay: 'NOT_APPROVED' },
  version: 1,
}
const BIG: Proposal = {
  ...DRAFT,
  lines: [...DRAFT.lines, line(5, S1, '2026/0405', 420000)],
  totals: { amount: 1362749, discount: 4301, lines: 3, held: 0, suppliers: 2 },
  approval: { dual: { needed: true, threshold: 1000000, decided: false, first: { by: APPROVER, at: '2026-11-14T08:40:00.000Z', standing: true } } },
  may: { ...DRAFT.may, approve: 'SECOND_APPROVER' },
}
const APPROVED: Proposal = { ...DRAFT, status: 'APPROVED', approvedBy: APPROVER, approvedAt: '2026-11-14T09:00:00.000Z', may: { change: 'NOT_DRAFT', approve: 'NOT_DRAFT', sendBack: null, cancel: null, pay: null }, version: 2 }
const PAID: Proposal = { ...APPROVED, status: 'PAID', paidAt: '2026-11-14T11:00:00.000Z', may: { change: 'NOT_DRAFT', approve: 'NOT_DRAFT', sendBack: 'NOT_APPROVED', cancel: 'NOT_APPROVED', pay: 'NOT_APPROVED' }, version: 3 }
const HELD: Proposal = { ...DRAFT, lines: [...DRAFT.lines, line(3, S3, 'TF-77', 46000, { account: null, held: true, problems: ['HELD'] })], totals: { ...DRAFT.totals, lines: 3, held: 1, suppliers: 3 }, may: { ...DRAFT.may, approve: 'HELD' } }
const ROWS: ProposalRow[] = [{ id: uid('3737', 9), companyId: uid('1111', 1), weekStart: '2026-11-02', week: 45, currency: 'EUR', status: 'PAID', lines: 4, held: 0, total: 1210000, approvedAt: '2026-11-04T09:00:00.000Z', paidAt: '2026-11-05T10:00:00.000Z', version: 3 }]

const START = { kind: 'start' as const, weekStart: '2026-11-09', candidates: CANDIDATES, problem: null, reading: false, picked: null, existing: ROWS, repick: null }
const model = (over: Partial<ProposalDialogModel> = {}): ProposalDialogModel => ({ prefix: '/w/ALFA', today: TODAY, can: FINANCE, stage: START, busy: false, problem: null, notice: null, ...over })
const noCost = (proposal: Proposal): Proposal => ({ ...proposal, lines: proposal.lines.map((entry) => ({ ...entry, amount: undefined, discountAmount: undefined, invoice: entry.invoice ? { ...entry.invoice, grossTotal: undefined, withholdingAmount: undefined } : null })), totals: { ...proposal.totals, amount: undefined, discount: undefined }, approval: { dual: { ...proposal.approval.dual, threshold: undefined } } })

export const designScreen = defineDesignScreen<ProposalDialogModel>({
  screen: 'SCR-515',
  title: 'Finance › Payables › Payment proposal — week 46',
  view: ProposalDialog,
  cases: [
    { id: 'start', label: 'Finance · The week\'s invoices by due date; one held without an account', model: model(), note: 'Overdue first; an early-payment discount typed per line; the invoices still to approve said apart.' },
    { id: 'start-discount', label: 'Finance · A discount typed on a line', model: model({ draft: { discounts: { [uid('3434', 2)]: '43,01' } } }) },
    { id: 'start-loading', label: 'Loading', model: model({ stage: { ...START, candidates: null, reading: true, existing: null } }) },
    { id: 'start-empty', label: 'Nothing due this week', model: model({ stage: { ...START, candidates: { ...CANDIDATES, items: [], waiting: [], totals: { invoices: 0, held: 0, payable: 0 } } } }) },
    { id: 'start-error', label: 'Could not read the invoices', model: model({ stage: { ...START, candidates: null, problem: 'problem.read.unavailable' } }) },
    { id: 'draft', label: 'Finance · Draft: approver ≠ the person who made it', model: model({ stage: { kind: 'proposal', proposal: DRAFT, problem: null }, notice: { key: scoped('proposal.notice.created'), params: { week: 46 } } }) },
    { id: 'draft-own', label: 'The maker cannot approve it (four eyes)', model: model({ stage: { kind: 'proposal', proposal: { ...DRAFT, may: { ...DRAFT.may, approve: 'OWN_PROPOSAL' } }, problem: null } }) },
    { id: 'draft-held', label: 'Held: a supplier without a usable account', model: model({ stage: { kind: 'proposal', proposal: HELD, problem: null } }) },
    { id: 'dual-first', label: 'Above the amount: approved once, a second person approves', model: model({ stage: { kind: 'proposal', proposal: BIG, problem: null }, notice: { key: scoped('proposal.notice.approved.FIRST') } }), note: 'The first approver is held: someone else gives the second yes.' },
    { id: 'approved', label: 'Approved: record the transfers made', model: model({ stage: { kind: 'proposal', proposal: APPROVED, problem: null }, notice: { key: scoped('proposal.notice.approved.SINGLE') } }) },
    { id: 'paid-form', label: 'Record paid: the day and the bank\'s reference', model: model({ stage: { kind: 'paid', proposal: APPROVED }, draft: { paidOn: TODAY, reference: 'CRO-0000-ESEMPIO-46' } }) },
    { id: 'paid', label: 'Paid; remittance mail switched off', model: model({ stage: { kind: 'proposal', proposal: PAID, problem: null }, notice: { key: scoped('proposal.notice.paidNoMail'), params: { count: 2 } } }) },
    { id: 'send-back', label: 'Send back with why', model: model({ stage: { kind: 'reason', move: 'send-back', proposal: APPROVED }, draft: { reason: 'A supplier asked to wait a week' } }) },
    { id: 'refused', label: 'Refused: an invoice is in another proposal', model: model({ stage: { kind: 'proposal', proposal: DRAFT, problem: null }, problem: { key: scoped('refusal.proposal.IN_ANOTHER_PROPOSAL'), reload: false } }) },
    { id: 'reader', label: 'Read only (payables.view): every move held with why', model: model({ can: READER, stage: { kind: 'proposal', proposal: { ...DRAFT, may: { change: 'NO_PERMISSION', approve: 'NO_PERMISSION', sendBack: 'NO_PERMISSION', cancel: 'NO_PERMISSION', pay: 'NO_PERMISSION' } }, problem: null } }) },
    { id: 'no-cost', label: 'Without the cost grain: no amount drawn', model: model({ can: { ...FINANCE, cost: false }, stage: { kind: 'proposal', proposal: noCost(DRAFT), problem: null } }) },
  ],
})
