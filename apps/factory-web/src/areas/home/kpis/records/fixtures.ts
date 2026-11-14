import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { DrillAnswer } from '../api'
import { BUILT, LEAD_DRILL, LEATHER_DRILL, NOW, OTIF_DRILL, PREFIX, inShell, marginDrill, recordFor, supplyDrill, wipDrill, type Role } from '../demo/fixtures'
import { kpisCanOf } from '../model'
import { RecordsView, type RecordsModel } from '../view/RecordsView'

/**
 * SCR-471 — the records behind a KPI (design home.kpis rec:KPI › Now "Click → records behind it"; ANA-003; B-W2b-429's
 * drills), with made-up data only: On-time in full (its overall equals the KPI, by customer, site and month, each order line
 * opening its order), the lead time from order to shipment (median and middle half per product family), work in progress
 * with and without the cost rights, leather yield (grade, lot, style), margins with and without the cost rights, supplier
 * on-time with shortages and cover and without the lists behind them, nothing in the period, a drill the rights refuse,
 * a KPI whose records are a report, loading, a failed read and no permission.
 */

interface Case {
  readonly role: Role
  readonly model: RecordsModel
}

const records = (key: string, drill: DrillAnswer | null, change: Partial<RecordsModel> = {}, role: Role = 'owner'): Case => ({
  role,
  model: {
    can: kpisCanOf(role === 'none' ? ['home.view'] : ['home.kpis.view']),
    prefix: PREFIX,
    key,
    kpi: change.kpi ?? { value: recordFor(key, role === 'none' ? 'owner' : role), problem: null },
    span: { from: null, to: null },
    drill: { value: drill, problem: null },
    built: BUILT,
    now: NOW,
    ...change,
  },
})

function RecordsDesign({ model }: { model: Case }) {
  return inShell('/home/kpis', createElement(RecordsView, { model: model.model }), model.role)
}

const emptyOtif: DrillAnswer = { name: 'otif', data: { ...(OTIF_DRILL.data as Extract<DrillAnswer, { name: 'otif' }>['data']), overall: { due: 0, onTime: 0, late: 0, pct: null }, byCustomer: [], bySite: [], byMonth: [], rows: [] } }

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-471',
  title: 'The records behind a KPI (Home › Insights › KPI library)',
  view: RecordsDesign,
  cases: [
    {
      id: 'otif',
      label: 'On-time in full — November',
      model: records('delivery.otif', OTIF_DRILL),
      note: '83.3 % = the KPI over the same days; 6 lines due, 5 on time, 1 late by 4 days. Each row opens its order (a real link). By customer, by site and by month below.',
    },
    { id: 'period', label: 'Another period typed', model: records('delivery.otif', OTIF_DRILL, { span: { from: '2026-10-01', to: '2026-11-14' } }), note: 'The period is the address’s (`?from=&to=`); Show this period writes it.' },
    { id: 'lead-times', label: 'Order to shipment', model: records('delivery.order_to_ship_days', LEAD_DRILL), note: 'The KPI is the average (7.5 days); the median and the middle half per product family come from the same orders.' },
    { id: 'wip', label: 'Work in progress (with cost rights)', model: records('production.wip_pieces', wipDrill(true)), note: 'Now (no period): garments per line and stage with their age bands, value at cost.' },
    { id: 'wip-planner', label: 'Work in progress (no cost rights)', model: records('production.wip_pieces', wipDrill(false), {}, 'planner'), note: 'No value column and no value tile: the money is not sent.' },
    { id: 'leather', label: 'Leather yield', model: records('production.leather_yield', LEATHER_DRILL), note: 'Yield 71.6 % of 42.60 m²; by grade, by supplier lot and by style.' },
    { id: 'margin', label: 'Margins (owner)', model: records('sales.margin_actual', marginDrill(true)), note: 'Quoted against actual on what shipped, with the amounts (price, cost and margin rights).' },
    { id: 'margin-percent', label: 'Margins — percents only', model: records('sales.margin_actual', marginDrill(false)), note: 'Margin rights without the cost rights: percents and points only, a note says why.' },
    { id: 'supply', label: 'Supplier on-time', model: records('purchasing.supplier_on_time', supplyDrill(true)), note: '4 of 5 receipt lines on time; open shortages per work order; days of cover of the leathers needed.' },
    { id: 'supply-hidden', label: 'Supplier on-time — no planning or stock list', model: records('purchasing.supplier_on_time', supplyDrill(false)), note: 'Shortages and cover say which list they need.' },
    { id: 'empty', label: 'Nothing in the period', model: records('delivery.otif', emptyOtif) },
    { id: 'needs-grain', label: 'Refused by rights', model: records('sales.margin_actual', null, { drill: { value: null, problem: { key: 'records.needsPermission', params: { permission: 'costing.view' } } } }, 'planner') },
    { id: 'no-drill', label: 'A KPI whose records are a report', model: records('production.scrap_rate', null), note: 'Its records are the Scrap by reason report: opened from the KPI’s Definition, not here.' },
    { id: 'loading', label: 'Loading', model: records('delivery.otif', null, { kpi: { value: null, problem: null } }) },
    { id: 'error', label: 'The records could not be read', model: records('delivery.otif', null, { drill: { value: null, problem: { key: 'error.offline' } } }) },
    { id: 'no-permission', label: 'No permission', model: records('delivery.otif', null, {}, 'none') },
  ],
})
