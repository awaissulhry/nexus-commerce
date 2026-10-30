import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, STOCK, stockWithoutValues, WORKSHOPS, type RoleCase } from '../demo/fixtures'
import { listCase } from '../list/fixtures'
import type { SubcontractingModel } from '../list/list-model'
import { stockKey } from '../list/view/StockSection'
import { SubcontractingView } from '../list/view/SubcontractingView'

/**
 * SCR-129 — Stock at subcontractors (design purchasing.subcontracting sec:stock; the page's ⋯ / switch "Stock at
 * subcontractors", `?show=stock`) with made-up stock only: each workshop a stock location with our material by lot, still
 * in our books, its lines and value per workshop (cost grain only), a workshop filter and a search, the selection with
 * Export, and the states (loading, error, none at any workshop, nothing matching). Roles: Owner and Buyer (values),
 * Warehouse and Planner (no money: no value column), Read-only, Sales (no purchasing.view).
 */

interface StockCase {
  role: RoleCase
  model: SubcontractingModel
}

function stockCase(role: RoleCase, over: Partial<SubcontractingModel> = {}): StockCase {
  const base = listCase(role, { show: 'stock', ...over })
  const stock = base.model.stock.value && !base.model.can.cost ? { ...base.model.stock, value: stockWithoutValues(base.model.stock.value) } : base.model.stock
  return { role, model: { ...base.model, stock } }
}

function StockDesign({ model }: { model: StockCase }) {
  return inShell('/purchasing/subcontracting', createElement(SubcontractingView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<StockCase>({
  screen: 'SCR-129',
  title: 'Stock at subcontractors',
  view: StockDesign,
  cases: [
    { id: 'stock', label: 'Our material at each workshop by lot, with its value (buyer)', model: stockCase('buyer'), note: 'The embroidery thread was never valued: “not valued”, never 0.' },
    { id: 'workshop-filter', label: 'One workshop', model: stockCase('buyer', { stockWorkshop: WORKSHOPS.sewing.id }) },
    { id: 'search', label: 'Search by lot', model: stockCase('buyer', { stockQ: 'LT-DEMO' }) },
    { id: 'no-match', label: 'Nothing matches the search', model: stockCase('buyer', { stockQ: 'zzz' }) },
    { id: 'selection', label: 'Selection: Export N (CSV)', model: stockCase('buyer', { selected: STOCK.rows.slice(0, 2).map(stockKey) }) },
    { id: 'truncated', label: 'Only the first lines (truncated)', model: stockCase('buyer', { stock: { value: { ...STOCK, truncated: true }, problem: null } }) },
    { id: 'empty', label: 'None of our material is at a workshop', model: stockCase('buyer', { stock: { value: { rows: [], workshops: [], truncated: false }, problem: null } }) },
    { id: 'loading', label: 'Loading, with the slow note', model: stockCase('buyer', { stock: { value: null, problem: null }, slow: true }) },
    { id: 'error', label: "Stock at subcontractors couldn't be read", model: stockCase('buyer', { stock: { value: null, problem: 'problem.read' } }) },
    { id: 'owner', label: 'Owner: with values', model: stockCase('owner') },
    { id: 'warehouse', label: 'Warehouse: no money (no value column)', model: stockCase('warehouse') },
    { id: 'planner', label: 'Planner: no money (no value column)', model: stockCase('planner') },
    { id: 'read-only', label: 'Read-only', model: stockCase('readOnly') },
    { id: 'sales', label: 'Sales: no purchasing.view — the page says so', model: stockCase('sales') },
  ],
})
