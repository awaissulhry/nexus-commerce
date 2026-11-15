import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { scoped } from '../../payments/riba/depth'
import type { AreaLine } from './api'
import { AreaCheckCard, type AreaCheckModel } from './view/AreaCheckCard'

/**
 * SCR-516 — the leather area check in a supplier invoice's Match tab (B-W2b-425; design finance.payables rec:Supplier invoice ›
 * Match › three-way#1), made-up data only: an invented order and hides, areas in square feet. No money.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const hide = (n: number, received: string, measured: string | null) => ({ id: uid('4545', n), code: `H-${String(n).padStart(4, '0')}`, lotId: uid('4646', 1), received, measured })
const line = (seq: number, over: Partial<AreaLine> = {}): AreaLine => ({
  lineId: uid('4747', seq),
  seq,
  description: 'Vitello pieno fiore nero',
  quantity: '105',
  uom: 'SQFT',
  order: { id: uid('4848', 1), number: 'PO-2026-00117', lineId: uid('4949', seq), lineSeq: seq, siteId: uid('5050', 1), uom: 'SQFT' },
  item: { id: uid('5151', 1), code: 'PEL-VIT-NERO', name: 'Vitello nero', baseUom: 'SQFT' },
  tolerancePercent: '2',
  toleranceFrom: 'COMPANY',
  lots: [{ id: uid('4646', 1), code: 'LOT-2026-0311' }],
  hides: [hide(1, '52.40', '52.10'), hide(2, '51.80', '51.80')],
  check: { invoiced: '105', invoicedTotal: '105', received: '104.20', measured: '103.90', measuredHides: 2, unmeasuredHides: 0, difference: '-1.10', differencePercent: '-1.05', outcome: 'WITHIN', opensClaim: false, shortfall: '0' },
  claim: { opens: false, held: null, existing: [] },
  ...over,
})
const SHORT = line(2, { quantity: '120', check: { invoiced: '120', invoicedTotal: '120', received: '112.60', measured: '111.10', measuredHides: 1, unmeasuredHides: 1, difference: '-8.90', differencePercent: '-7.42', outcome: 'SHORT', opensClaim: true, shortfall: '8.90' }, claim: { opens: true, held: null, existing: [] }, toleranceFrom: 'ORDER_LINE', tolerancePercent: '3' })

const model = (over: Partial<AreaCheckModel> = {}): AreaCheckModel => ({ prefix: '/w/ALFA', can: { view: true, purchasing: true }, lines: [line(1), SHORT], problem: null, busy: null, claimProblem: null, opened: null, ...over })

export const designScreen = defineDesignScreen<AreaCheckModel>({
  screen: 'SCR-516',
  title: 'Finance › Payables › Supplier invoice › Match: leather area check',
  view: AreaCheckCard,
  cases: [
    { id: 'normal', label: 'One line within the tolerance, one short: Open area claim', model: model(), note: 'An unmeasured hide counts with the area it came with; the words say how many were measured.' },
    { id: 'opened', label: 'Claim opened (a draft in Purchasing)', model: model({ lines: [line(1), { ...SHORT, claim: { opens: true, held: null, existing: [{ id: uid('5252', 1), number: 'RC-2026-0031', status: 'DRAFT' }] } }], opened: { lineId: SHORT.lineId, claim: { id: uid('5252', 1), number: 'RC-2026-0031' } } }) },
    { id: 'no-right', label: 'Without purchasing.claims.manage: the claim waits with why', model: model({ can: { view: true, purchasing: false }, lines: [{ ...SHORT, claim: { opens: true, held: 'x', existing: [] } }] }) },
    { id: 'refused', label: 'Refused: nothing to claim any more', model: model({ lines: [SHORT], claimProblem: { lineId: SHORT.lineId, phrase: { key: scoped('refusal.area.NOTHING_TO_CLAIM') } } }) },
    { id: 'over-and-none', label: 'Over what was invoiced; nothing received yet', model: model({ lines: [line(1, { check: { ...line(1).check!, measured: '108.20', difference: '3.20', differencePercent: '3.05', outcome: 'OVER' } }), line(3, { hides: [], lots: [], check: { invoiced: '60', invoicedTotal: '60', received: '0', measured: '0', measuredHides: 0, unmeasuredHides: 0, difference: '-60', differencePercent: '-100', outcome: 'NOT_RECEIVED', opensClaim: false, shortfall: '0' } })] }) },
    { id: 'none', label: 'No leather line on this invoice', model: model({ lines: [] }) },
    { id: 'loading', label: 'Loading', model: model({ lines: null }) },
    { id: 'error', label: 'Could not read the check', model: model({ lines: null, problem: 'problem.read.unavailable' }) },
  ],
})
