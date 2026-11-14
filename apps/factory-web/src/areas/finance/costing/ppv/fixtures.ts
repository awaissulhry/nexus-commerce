import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canAs, inShell, PREFIX, TODAY, type Role } from '../demo/fixtures'
import { designScreen as costingScreen } from '../fixtures'
import { periodOf } from '../model'
import { CostingView } from '../view/CostingView'
import type { PpvRow } from './api'
import type { PpvSectionModel } from './model'
import { PpvSection } from './view/PpvSection'

/**
 * SCR-462 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv; FIN-031; B-W2b-424) with made-up data
 * only: an invented company's October receipts and invoices of leather, lining and thread from invented suppliers, each
 * at the standard it is compared with, what was paid and the difference (above and below), a variance reversed with its
 * reason and its reversal, the totals per currency, two rows chosen with Export 2 (CSV), the keys in the footer, "Waits for
 * the accountant…" while the company's figures are off, Show more, the states (loading with "Still loading…", failed,
 * empty) and the roles: Finance (every figure), Production manager and Sales (no cost grain: no unit cost or difference
 * column). The section in its place on Standard vs actual (after the cost ledger).
 */

const uid = (n: number) => `0190f0e2-4444-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid(1)
const LEATHER = { id: uid(11), code: 'DEMO-LTH-01', name: 'Pelle bovina demo', baseUom: 'FT2' }
const LINING = { id: uid(12), code: 'DEMO-LIN-02', name: 'Fodera rete demo', baseUom: 'M' }
const THREAD = { id: uid(13), code: 'DEMO-THR-03', name: 'Filo poliestere demo', baseUom: 'PCS' }
const CONCERIA = { id: uid(21), name: 'Conceria Esempio S.r.l.' }
const TESSUTI = { id: uid(22), name: 'Tessuti Demo S.p.A.' }

const row = (n: number, over: Partial<PpvRow> & Pick<PpvRow, 'item' | 'supplier' | 'quantity' | 'standardUnitCost' | 'paidUnitCost' | 'differenceAmount'>): PpvRow => ({
  id: uid(100 + n),
  companyId: COMPANY,
  source: { at: 'INVOICE', documentId: uid(200 + n), number: `FA-DEMO-${String(40 + n).padStart(4, '0')}`, lineId: uid(300 + n), seq: 1 },
  postedAt: `2026-10-${String(28 - n).padStart(2, '0')}T10:15:00.000Z`,
  day: `2026-10-${String(28 - n).padStart(2, '0')}`,
  currency: 'EUR',
  reversalOfId: null,
  reversedBy: null,
  reason: null,
  ...over,
})

/**
 * Leather 600 ft² at 4.00 against 3.90: +60.00. Lining 120 m at 2.85 against 3.00: −18.00. Thread 40 cones at 1.30 against
 * 1.25: +2.00. Leather 200 ft² at 4.05 against 3.90 (+30.00), reversed (counted on the wrong invoice) and its reversal −30.00.
 * Total +44.00 over 5 lines.
 */
export const PPV_ROWS: PpvRow[] = [
  row(1, { item: LEATHER, supplier: CONCERIA, quantity: '600.0000', standardUnitCost: '3.900000', paidUnitCost: '4.000000', differenceAmount: 6000 }),
  row(2, { item: LINING, supplier: TESSUTI, quantity: '120.0000', standardUnitCost: '3.000000', paidUnitCost: '2.850000', differenceAmount: -1800, source: { at: 'INVOICE', documentId: uid(202), number: 'FA-DEMO-0042', lineId: uid(302), seq: 2 } }),
  row(3, { item: THREAD, supplier: TESSUTI, quantity: '40.0000', standardUnitCost: '1.250000', paidUnitCost: '1.300000', differenceAmount: 200, source: { at: 'INVOICE', documentId: uid(202), number: 'FA-DEMO-0042', lineId: uid(303), seq: 3 } }),
  row(4, { item: LEATHER, supplier: CONCERIA, quantity: '-200.0000', standardUnitCost: '3.900000', paidUnitCost: '4.050000', differenceAmount: -3000, reversalOfId: uid(105), reason: 'Counted on the wrong invoice' }),
  row(5, { item: LEATHER, supplier: CONCERIA, quantity: '200.0000', standardUnitCost: '3.900000', paidUnitCost: '4.050000', differenceAmount: 3000, reversedBy: { id: uid(104), postedAt: '2026-10-24T10:15:00.000Z', reason: 'Counted on the wrong invoice' } }),
]
const TOTALS = [{ currency: 'EUR', differenceAmount: 4400, rows: 5 }]

/** What the API sends a person without the cost grain: no unit cost, no difference. */
const withoutCost = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([key]) => !['standardUnitCost', 'paidUnitCost', 'differenceAmount'].includes(key))) as T

const section = (role: Role, over: Partial<PpvSectionModel> = {}): PpvSectionModel => {
  const cost = canAs(role).cost
  return {
    cost,
    period: periodOf(null, TODAY),
    rows: cost ? PPV_ROWS : PPV_ROWS.map((entry) => withoutCost(entry)),
    more: false,
    problem: null,
    slow: false,
    totals: cost ? TOTALS : TOTALS.map((entry) => withoutCost(entry)),
    waits: false,
    ...over,
  }
}

interface Case {
  role: Role
  section: PpvSectionModel
  /** Shown in its place on the whole page (after the cost ledger) instead of alone. */
  inPage?: boolean
}

function PpvDesign({ model }: { model: Case }) {
  const node = createElement(PpvSection, { model: model.section, prefix: PREFIX })
  if (!model.inPage) return inShell('/finance/costing', node, model.role)
  const page = costingScreen.cases.find((item) => item.id === 'finance')!.model.page
  return inShell('/finance/costing', createElement(CostingView, { model: page, ppv: node }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-462',
  title: 'Standard vs actual › Purchase price variance: material, supplier, standard, paid, difference at the receipt or the invoice',
  view: PpvDesign,
  cases: [
    { id: 'finance', label: 'Finance · October: paid above and below the standard, one reversed with its reason; total per currency', model: { role: 'finance', section: section('finance') }, note: '+60.00 − 18.00 + 2.00 + 30.00 − 30.00 = +44.00 over 5 lines.' },
    { id: 'in-page', label: 'Finance · the section in its place on Standard vs actual (after the cost ledger)', model: { role: 'finance', section: section('finance'), inPage: true } },
    { id: 'selected', label: 'Two rows chosen · Export 2 (CSV)', model: { role: 'finance', section: section('finance', { selected: [PPV_ROWS[0]!.id, PPV_ROWS[1]!.id] }) } },
    { id: 'keys', label: 'Keys in the footer info icon', model: { role: 'finance', section: section('finance', { keysOpen: true, focusRow: 0 }) } },
    { id: 'more', label: 'More than a page: Show more', model: { role: 'finance', section: section('finance', { more: true }) } },
    { id: 'waits', label: 'The company’s figures for the accountant are off: "Waits for the accountant…", nothing posted', model: { role: 'finance', section: section('finance', { rows: [], totals: [], waits: true }) } },
    { id: 'manager', label: 'Production manager · no cost grain: no standard, paid or difference column (never ‘—’)', model: { role: 'manager', section: section('manager') } },
    { id: 'sales', label: 'Sales · no cost grain: materials, suppliers, documents and quantities only', model: { role: 'sales', section: section('sales') } },
    { id: 'empty', label: 'No receipts in this period', model: { role: 'finance', section: section('finance', { rows: [], totals: [] }) } },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: { role: 'finance', section: section('finance', { rows: null, totals: null, slow: true }) } },
    { id: 'error', label: "Error · couldn't load, Try again (never drawn as empty)", model: { role: 'finance', section: section('finance', { rows: null, totals: null, problem: 'problem.unavailable' }) } },
  ],
})
