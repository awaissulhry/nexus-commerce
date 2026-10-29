import { defineDesignScreen } from '../../../lib/design/design-screen'
import { approvalRow, CAN, GRAINS, PEOPLE, PREFIX, pending, withoutCost } from '../../sales/quotes/record/fixtures'
import type { ApprovalRow } from '../../sales/quotes/api'
import type { ApprovalsViewModel } from './model'
import { ApprovalsView } from './view/ApprovalsView'

/**
 * SCR-030 Approvals — made-up data only (PLAN §3.1). Each case is one state the Owner reviews, per role: Finance
 * deciding (the queue, the review with the numbers, the reject reason), the Owner held on their own request (four eyes),
 * an approver without margin rights held on a margin request, Sales watching their own requests, the decided view,
 * empty, loading, an error and a request that changed since it was asked.
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const second = approvalRow({ id: '0190f0e2-9999-7000-8000-200000000002', quoteId: '0190f0e2-9999-7000-8000-000000000140', number: 'Q-2026-0140', partyName: 'Moto Club Esempio', reasons: ['DISCOUNT_LIMIT'], requestNote: null, marginPct: '26.4000', netAmount: 1824000, grossAmount: 2225280, askedBy: { id: PEOPLE.owner, name: 'Olga Titolare', you: false }, askedAt: at(28, 15, 30) })
const WAITING: ApprovalRow[] = [approvalRow(), second]

function model(overrides: Partial<ApprovalsViewModel> = {}): ApprovalsViewModel {
  return {
    prefix: PREFIX,
    me: PEOPLE.finance,
    grains: GRAINS.finance,
    can: CAN.finance,
    view: 'waiting',
    rows: { items: WAITING, problem: null },
    counts: { waiting: 2, mine: 0, decided: 3, capped: false },
    asOf: at(29, 10, 42),
    open: null,
    rejecting: false,
    busy: false,
    notice: null,
    ...overrides,
  }
}

const review = { id: WAITING[0]!.id, quote: { status: 'ready' as const, value: pending() } }

export const designScreen = defineDesignScreen<ApprovalsViewModel>({
  screen: 'SCR-030',
  title: 'Approvals: the queue, my requests, the review',
  view: ApprovalsView,
  cases: [
    { id: 'finance-queue', label: 'Finance · waiting for me', model: model(), note: 'Each row says what is asked and why ("margin 18.9 % under the 20 % floor"), who asked, the net and since when.' },
    { id: 'selected', label: 'Finance · two requests selected', model: model({ selected: WAITING.map((row) => row.id), focusRow: 0 }), note: 'Approve 2 in the toolbar. When a selected request is not yours to decide, the button is held and says why.' },
    { id: 'finance-review', label: 'Finance · the review (A approve, R reject, J / K)', model: model({ open: review }), note: 'Still current · checked 10:42; the numbers behind the rule; the lines under the floor; the note; Open full quote.' },
    { id: 'reject', label: 'Finance · reject with a reason', model: model({ open: review, rejecting: true }) },
    { id: 'changed', label: 'Changed since asked (held)', model: model({ open: { id: WAITING[0]!.id, quote: { status: 'ready', value: { ...pending(), version: 9 } } } }), note: 'The quote moved after the request: Approve and Reject are held, the line says why.' },
    { id: 'owner-own', label: 'Owner · own request (four eyes)', model: model({ me: PEOPLE.owner, grains: GRAINS.owner, can: CAN.owner, view: 'mine', rows: { items: [approvalRow({ askedBy: { id: PEOPLE.owner, name: 'Olga Titolare', you: true }, mayDecide: false, held: 'OWN_REQUEST' })], problem: null }, counts: { waiting: 0, mine: 1, decided: 0, capped: false }, open: { id: WAITING[0]!.id, quote: { status: 'ready', value: pending(PEOPLE.owner) } } }), note: 'Approve is held: "You asked for this: another approver decides."' },
    { id: 'blind-approver', label: 'An approver without margin rights', model: model({ grains: GRAINS.priceOnly, rows: { items: [approvalRow({ marginPct: undefined, marginFloorPct: undefined, mayDecide: false, held: 'NEEDS_MARGIN' })], problem: null }, open: { id: WAITING[0]!.id, quote: { status: 'ready', value: withoutCost({ ...pending(), current: { ...pending().current, marginPct: undefined, marginFloorPct: undefined, marginFloorBreached: undefined } }) } } }), note: 'A margin-floor request: held, and no margin figure is shown.' },
    { id: 'sales-mine', label: 'Sales · my requests', model: model({ me: PEOPLE.sales, grains: GRAINS.sales, can: CAN.sales, view: 'mine', rows: { items: [approvalRow({ askedBy: { id: PEOPLE.sales, name: 'Sara Vendite', you: true }, mayDecide: false, held: 'OWN_REQUEST' }), approvalRow({ id: '0190f0e2-9999-7000-8000-200000000003', number: 'Q-2026-0131', status: 'REJECTED', askedBy: { id: PEOPLE.sales, name: 'Sara Vendite', you: true }, decidedBy: { id: PEOPLE.finance, name: 'Fiona Conti', you: false }, decidedAt: at(27, 11), decisionNote: 'Margine troppo basso.', mayDecide: false, held: 'NOT_WAITING' })], problem: null }, counts: { waiting: 0, mine: 1, decided: 1, capped: false } }) },
    { id: 'decided', label: 'Decided in the last 7 days', model: model({ view: 'decided', rows: { items: [approvalRow({ status: 'APPROVED', decidedBy: { id: PEOPLE.finance, name: 'Fiona Conti', you: true }, decidedAt: at(29, 10, 12), decisionNote: 'Ok per il primo ordine.', mayDecide: false, held: 'NOT_WAITING' })], problem: null } }) },
    { id: 'empty', label: 'Nothing waits for me', model: model({ rows: { items: [], problem: null }, counts: { waiting: 0, mine: 2, decided: 0, capped: false } }), note: 'The empty state offers "Your requests: 2 waiting · Show".' },
    { id: 'loading', label: 'Loading', model: model({ rows: { items: null, problem: null }, counts: { waiting: null, mine: null, decided: null, capped: false }, asOf: null }) },
    { id: 'error', label: 'Error', model: model({ rows: { items: null, problem: 'problem.read.unavailable' }, counts: { waiting: null, mine: null, decided: null, capped: false } }) },
    { id: 'no-permission', label: 'No permission', model: model({ rows: { items: null, problem: 'problem.read.forbidden' }, can: { view: false, manage: false, approve: false, send: false }, counts: { waiting: null, mine: null, decided: null, capped: false } }) },
    { id: 'notice', label: 'After a decision: the next request opens', model: model({ rows: { items: [second], problem: null }, counts: { waiting: 1, mine: 0, decided: 4, capped: false }, notice: { key: 'notice.approved', tone: 'success', params: { number: 'Q-2026-0142' } }, open: { id: second.id, quote: { status: 'ready', value: { ...pending(PEOPLE.owner), id: second.quoteId, number: second.number } } } }) },
  ],
})

