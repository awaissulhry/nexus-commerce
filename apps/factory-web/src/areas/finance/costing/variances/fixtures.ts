import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canAs, inShell, PREFIX, TODAY, type Role } from '../demo/fixtures'
import { designScreen as costingScreen } from '../fixtures'
import { periodOf } from '../model'
import { CostingView } from '../view/CostingView'
import type { VarianceRow } from './api'
import type { VariancesSectionModel } from './model'
import { VariancesSection } from './view/VariancesSection'

/**
 * SCR-462-variances — Finance › Costing › Variances by work order (design finance.costing: the bridge's "biggest reason"
 * across work orders; FIN-030; B-W2b-GB02, B-W2b-424's gap 5) with made-up data only: the invented October closes of two
 * work orders — leather used above its standard, labour quicker than standard, garments scrapped, leather bought dearer —
 * standard against actual with the unit costs, the amount above or below, the totals per currency and per category, two
 * lines chosen with Export 2 (CSV), the keys in the footer, "Waits for the accountant…" while the company's figures are
 * off, Show more, the states (loading with "Still loading…", failed, empty) and the production manager without the cost
 * grain (no unit cost or amount). The section in its place on Standard vs actual (after the purchase price variance).
 */

const uid = (n: number) => `0190f0e2-4545-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid(1)
const SITE = uid(2)
const WO_198 = { id: uid(11), number: 'WO-2026-0198' }
const WO_185 = { id: uid(12), number: 'WO-2026-0185' }
const LEATHER = { id: uid(21), code: 'DEMO-LTH-01', name: 'Pelle bovina demo', baseUom: 'FT2' }

const line = (n: number, over: Partial<VarianceRow> & Pick<VarianceRow, 'workOrder' | 'category'>): VarianceRow => ({
  id: uid(100 + n),
  closeId: uid(200 + (over.workOrder.id === WO_198.id ? 1 : 2)),
  companyId: COMPANY,
  siteId: SITE,
  item: null,
  standardQuantity: null,
  actualQuantity: null,
  standardUnitCost: null,
  actualUnitCost: null,
  amount: 0,
  currency: 'EUR',
  closedAt: over.workOrder.id === WO_198.id ? '2026-10-27T16:05:00.000Z' : '2026-10-15T11:30:00.000Z',
  live: true,
  note: null,
  ...over,
})

/**
 * WO-0198: leather 416 ft² used against 400 at 3.90 (+62.40); 640 standard minutes earned in 600 at 0.375 (−15.00, written
 * as minutes); 1 garment scrapped at 39.00 (+39.00). WO-0185: leather 300 ft² at 3.94 against 3.90 (+12.00). Total +98.40.
 */
export const VARIANCE_ROWS: VarianceRow[] = [
  line(1, { workOrder: WO_198, category: 'MATERIAL_USAGE', item: LEATHER, standardQuantity: '400.0000', actualQuantity: '416.0000', standardUnitCost: '3.900000', actualUnitCost: '3.900000', amount: 6240 }),
  line(2, { workOrder: WO_198, category: 'LABOUR_EFFICIENCY', standardQuantity: '640.0000', actualQuantity: '600.0000', standardUnitCost: '0.375000', actualUnitCost: '0.375000', amount: -1500 }),
  line(3, { workOrder: WO_198, category: 'SCRAP', standardQuantity: '0.0000', actualQuantity: '1.0000', standardUnitCost: '39.000000', actualUnitCost: '39.000000', amount: 3900 }),
  line(4, { workOrder: WO_185, category: 'MATERIAL_PRICE', item: LEATHER, standardQuantity: '300.0000', actualQuantity: '300.0000', standardUnitCost: '3.900000', actualUnitCost: '3.940000', amount: 1200 }),
]
const TOTALS = [
  { currency: 'EUR', category: 'MATERIAL_PRICE' as const, lines: 1, amount: 1200 },
  { currency: 'EUR', category: 'MATERIAL_USAGE' as const, lines: 1, amount: 6240 },
  { currency: 'EUR', category: 'LABOUR_EFFICIENCY' as const, lines: 1, amount: -1500 },
  { currency: 'EUR', category: 'SCRAP' as const, lines: 1, amount: 3900 },
]

/** What the API sends a person without the cost grain: no unit cost, no amount. */
const withoutCost = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([key]) => !['standardUnitCost', 'actualUnitCost', 'amount'].includes(key))) as T

const section = (role: Role, over: Partial<VariancesSectionModel> = {}): VariancesSectionModel => {
  const cost = canAs(role).cost
  return {
    cost,
    period: periodOf(null, TODAY),
    rows: cost ? VARIANCE_ROWS : VARIANCE_ROWS.map((entry) => withoutCost(entry)),
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
  section: VariancesSectionModel
  /** Shown in its place on the whole page (after the purchase price variance) instead of alone. */
  inPage?: boolean
}

function VariancesDesign({ model }: { model: Case }) {
  const node = createElement(VariancesSection, { model: model.section, prefix: PREFIX })
  if (!model.inPage) return inShell('/finance/costing', node, model.role)
  const page = costingScreen.cases.find((item) => item.id === 'finance')!.model.page
  return inShell('/finance/costing', createElement(CostingView, { model: page, variances: node }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-462-variances',
  title: 'Standard vs actual › Variances by work order: the lines of the period’s closes, by category, standard against actual',
  view: VariancesDesign,
  cases: [
    { id: 'finance', label: 'Finance · October: two work orders closed, their variance lines by category; totals per currency and category', model: { role: 'finance', section: section('finance') }, note: '+62.40 − 15.00 + 39.00 + 12.00 = +98.40 over 4 lines.' },
    { id: 'in-page', label: 'Finance · the section in its place on Standard vs actual', model: { role: 'finance', section: section('finance'), inPage: true } },
    { id: 'selected', label: 'Two lines chosen · Export 2 (CSV)', model: { role: 'finance', section: section('finance', { selected: [VARIANCE_ROWS[0]!.id, VARIANCE_ROWS[3]!.id] }) } },
    { id: 'keys', label: 'Keys in the footer info icon', model: { role: 'finance', section: section('finance', { keysOpen: true, focusRow: 0 }) } },
    { id: 'more', label: 'More than a page: Show more', model: { role: 'finance', section: section('finance', { more: true }) } },
    { id: 'waits', label: 'The company’s figures for the accountant are off: closes are a status, nothing split', model: { role: 'finance', section: section('finance', { rows: [], totals: [], waits: true }) } },
    { id: 'manager', label: 'Production manager · no cost grain: no unit cost or amount (never ‘—’)', model: { role: 'manager', section: section('manager') } },
    { id: 'empty', label: 'No close in this period', model: { role: 'finance', section: section('finance', { rows: [], totals: [] }) } },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: { role: 'finance', section: section('finance', { rows: null, totals: null, slow: true }) } },
    { id: 'error', label: "Error · couldn't load, Try again (never drawn as empty)", model: { role: 'finance', section: section('finance', { rows: null, totals: null, problem: 'problem.unavailable' }) } },
  ],
})
