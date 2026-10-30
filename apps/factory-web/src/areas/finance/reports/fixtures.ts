import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canAs, EMPTY, inShell, KEY_101, LAYERS_101, NOW, PREFIX, ROWS, SITES, TODAY, VALUATION, VALUATION_SEPTEMBER, withoutCost, type Role } from './demo/fixtures'
import { addressOf, rowId } from './model'
import { ValuationView, type ValuationModel } from './view/ValuationView'

/**
 * SCR-239 — Finance reports › Stock valuation (design finance.reports) with made-up data only: the stock of a demo company
 * on a day by category (raw leather, materials, trims, packaging, finished goods, WIP), its totals, the method in words
 * (UNDECIDED: to confirm with the accountant), "How this lot is valued" (loading, read, failed), a past date, one list
 * not grouped, the rows chosen for Export N, live updates waiting, and the states (loading with "Still loading…", error,
 * empty date, nothing matching, offline) and roles: Finance and Owner (values), Warehouse (quantities only: the value
 * columns are not drawn), Sales (no stock permission).
 */

interface Case {
  role: Role
  page: ValuationModel
}

const ADDRESS = addressOf(null)

const base = (role: Role, over: Partial<ValuationModel> = {}): Case => {
  const can = canAs(role)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      address: ADDRESS,
      sites: SITES,
      valuation: { value: can.cost ? VALUATION : withoutCost(VALUATION), problem: null, slow: false },
      readAt: NOW - 60_000,
      now: NOW,
      live: 'live',
      updates: 0,
      howValued: null,
      ...over,
    },
  }
}

function ValuationDesign({ model }: { model: Case }) {
  return inShell('/finance/reports', createElement(ValuationView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-239',
  title: 'Finance reports: stock valuation at any date, by category, with how each lot is valued',
  view: ValuationDesign,
  cases: [
    { id: 'finance', label: 'Finance · Stock valued today, grouped by category', model: base('finance'), note: 'Totals 3,536.74 by hand: leather 1,197.30 · materials 372.00 · trims 255.00 · packaging 60.00 · finished goods 1,320.00 · WIP 332.44. The protector lot has no value (no cost yet): flagged, never drawn as zero.' },
    { id: 'owner', label: 'Owner · the same report', model: base('owner') },
    { id: 'how-valued', label: 'How this lot is valued · LOT-2026-0101', model: base('finance', { howValued: { key: KEY_101, value: LAYERS_101, problem: null } }), note: 'Opened from the value cell: the receipt at PO-2026-0007\'s 4.20/ft², the issue to WO-2026-0042 at the lot\'s 4.20; 186.5 ft², 783.30.' },
    { id: 'how-valued-loading', label: 'How this lot is valued · reading', model: base('finance', { howValued: { key: KEY_101, value: null, problem: null } }) },
    { id: 'how-valued-error', label: 'How this lot is valued · failed', model: base('finance', { howValued: { key: KEY_101, value: null, problem: 'problem.unavailable' } }) },
    { id: 'warehouse', label: 'Warehouse · quantities, areas and hides; no value columns', model: base('warehouse'), note: 'Without the cost grain the API drops every value: the columns are not drawn (never a "—") and the totals show rows only.' },
    { id: 'as-at', label: 'As at 30 September · rounding left noted', model: base('finance', { address: { ...ADDRESS, asOf: '2026-09-30' }, valuation: { value: VALUATION_SEPTEMBER, problem: null, slow: false } }) },
    { id: 'not-grouped', label: 'One list by item (Group by category off)', model: base('finance', { address: { ...ADDRESS, group: false } }) },
    { id: 'one-category', label: 'Category: raw leather, searched "LTH"', model: base('finance', { address: { ...ADDRESS, category: 'LEATHER', q: 'LTH' }, valuation: { value: { ...VALUATION, rows: ROWS.filter((row) => row.category === 'LEATHER'), categories: VALUATION.categories.filter((entry) => entry.category === 'LEATHER'), value: 119730, unvaluedMoves: 0 }, problem: null, slow: false } }) },
    { id: 'selected', label: 'Two rows chosen · Export 2 (CSV)', model: base('finance', { selected: [rowId(ROWS[0]!), rowId(ROWS[2]!)] }) },
    { id: 'updates', label: 'Live · 3 stock moves since the read', model: base('finance', { updates: 3 }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base('finance', { keysOpen: true, focusRow: 0 }) },
    { id: 'empty', label: 'No stock on this date', model: base('finance', { address: { ...ADDRESS, asOf: '2025-12-31' }, valuation: { value: EMPTY, problem: null, slow: false } }) },
    { id: 'no-match', label: 'Nothing matches the filters', model: base('finance', { address: { ...ADDRESS, site: SITES[1]!.id, q: 'ZZZ' }, valuation: { value: { ...VALUATION, rows: [], categories: [], value: 0, unvaluedMoves: 0 }, problem: null, slow: false } }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: base('finance', { valuation: { value: null, problem: null, slow: true }, readAt: null }) },
    { id: 'error', label: "Error · couldn't load, Try again", model: base('finance', { valuation: { value: null, problem: 'problem.unavailable', slow: false }, readAt: null }) },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Sales · no stock permission', model: base('sales', { valuation: { value: null, problem: null, slow: false }, readAt: null }) },
  ],
})
