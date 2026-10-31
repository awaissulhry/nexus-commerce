import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { asSeenBy, INV_0350, INV_0412, INV_0501, PREFIX, ROWS } from '../demo/fixtures'
import { PoInvoicesView, type PoInvoicesModel } from './view/PoInvoicesView'

/**
 * SCR-059 Invoices tab — the PO studio's Invoices tab (design purchasing.orders "Record: Purchase order" › Invoices, W2a)
 * with made-up data only: the supplier invoices with a line on PO-2026-0101 (a price difference, goods not arrived, paid),
 * no invoice yet, couldn't load, loading, a role without the cost grain (no amount column) and one without payables.view.
 */

const rows = ROWS.filter((row) => [INV_0412, INV_0501, INV_0350].includes(row.id))
const base = (over: Partial<PoInvoicesModel> = {}): PoInvoicesModel => ({ prefix: PREFIX, view: true, cost: true, rows, problem: null, more: false, ...over })

function PoInvoicesDesign({ model }: { model: PoInvoicesModel }) {
  return createElement('div', { className: 'fw-fpy' }, createElement(PoInvoicesView, { model }))
}

export const designScreen = defineDesignScreen<PoInvoicesModel>({
  screen: 'SCR-059-invoices',
  title: 'Purchase order › Invoices: the supplier invoices matched to this PO in Finance',
  view: PoInvoicesDesign,
  cases: [
    { id: 'rows', label: 'Three invoices on this order: a price difference, goods not arrived, paid', model: base() },
    { id: 'no-cost', label: 'A buyer-like role without the cost grain: no amount column', model: base({ cost: false, rows: asSeenBy(rows, { cost: false }) }) },
    { id: 'more', label: 'More than 50: only the newest shown, the rest in Finance', model: base({ more: true }) },
    { id: 'empty', label: 'No invoice yet', model: base({ rows: [] }) },
    { id: 'loading', label: 'Loading', model: base({ rows: null }) },
    { id: 'error', label: "Couldn't load supplier invoices: Try again", model: base({ rows: null, problem: 'problem.read.unavailable' }) },
    { id: 'no-permission', label: 'No payables.view (the tab is not drawn in the studio; the part says why)', model: base({ view: false, rows: null }) },
  ],
})
