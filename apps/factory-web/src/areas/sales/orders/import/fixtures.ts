import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../_demo/fixtures'
import { demoOrdersImport } from '../depth/demo/fixtures'
import { OrdersImportView, type OrdersImportModel } from './view/OrdersImportView'
import { BRAND_BETA } from '../../../../lib/testing/two-brands' // B-TH-293
import type { ImportMemory } from './memory' // B-TH-293

/**
 * SCR-429 — Import orders (design sales.orders pop:orders.import, band overflow "Import orders (W2b, dry run)"; B-W2b-323 on
 * B-W2b-303's `sales.orders` importer) with made-up data only: the sheet chosen, the dry run (the orders it would make, the
 * refused rows with their reasons, nothing written), applying, applied, a sheet that could not be read, and Apply held without
 * imports.apply. The wizard is drawn in place (a dialog opens only in a browser).
 */

interface ImportCase {
  model: OrdersImportModel
}

// ── B-TH-293: Brand Beta's sheet (made up): its last import of the same headers, read with other columns, or the same ──
export const DEMO_MEMORY: ImportMemory = Object.freeze({
  customer: BRAND_BETA.tradeName,
  fileName: 'Brand Beta order sheet week 45.xlsx',
  appliedAt: '2026-11-10T09:00:00.000Z',
  same: false,
  mapping: Object.freeze({ 'Art.': 'style', 'Col.': 'colour', Tg: 'size', 'Q.tà': 'quantity', Rif: 'order' }),
  busy: false,
})
// ── end B-TH-293 ──

function ImportDesign({ model }: { model: ImportCase }) {
  return inShell('/sales/orders', createElement(OrdersImportView, { model: model.model }), 'sales')
}

export const designScreen = defineDesignScreen<ImportCase>({
  screen: 'SCR-429',
  title: 'Import orders (Sales › Orders): upload, dry run, apply',
  view: ImportDesign,
  cases: [
    { id: 'upload', label: 'Sales · The sheet chosen: number format, sheet, Check (nothing written)', model: { model: { sheet: demoOrdersImport('upload'), inline: true } } },
    { id: 'planned', label: 'Sales · The dry run: 7 rows make orders, 2 refused with their reasons (Apply: every order or none)', model: { model: { sheet: demoOrdersImport('planned'), inline: true } }, note: 'Download the refused rows, fix them in the sheet, check again.' },
    { id: 'applying', label: 'Sales · Applying', model: { model: { sheet: demoOrdersImport('applying'), inline: true } } },
    { id: 'applied', label: 'Sales · Applied: the orders made (an order a rule holds waits for a yes)', model: { model: { sheet: demoOrdersImport('applied'), inline: true } } },
    { id: 'failed', label: 'Sales · The sheet could not be read: upload a corrected one', model: { model: { sheet: demoOrdersImport('failed'), inline: true } } },
    { id: 'no-apply', label: 'A person without imports.apply: Apply held with its reason', model: { model: { sheet: demoOrdersImport('planned', { run: true, apply: false }), inline: true } } },
    // B-TH-293 (SHEET-G13, W17): on one customer's sheet, its remembered columns in one line.
    { id: 'memory-offer', label: 'Brand Beta’s sheet: its last sheet with these headers used other columns — Use them', model: { model: { sheet: demoOrdersImport('planned'), inline: true, memory: DEMO_MEMORY } }, note: 'Asked only for the sheet’s own customer (the Customer switcher); never another customer’s columns.' },
    { id: 'memory-same', label: 'Brand Beta’s sheet: read as in its last sheet (nothing to do)', model: { model: { sheet: demoOrdersImport('planned'), inline: true, memory: { ...DEMO_MEMORY, same: true } } } },
  ],
})
