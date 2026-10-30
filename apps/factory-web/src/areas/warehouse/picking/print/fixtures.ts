import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, printModel, type PickRole } from '../demo/fixtures'
import type { PrintModel } from '../view-model'
import { PickingPrintView } from './view/PickingPrintView'

/**
 * SCR-237-print — the pick lists on paper (design warehouse.picking tab:pk-tab-pdf, "Pick list PDF (sorted by bin path)"),
 * made-up data only: two work orders in one walk through the store, then each one's lines; reading, failed, nothing asked,
 * and a role without inventory.stock.view.
 */

interface Case {
  role: PickRole
  page: PrintModel
}

function PrintDesign({ model }: { model: Case }) {
  return inShell('/warehouse/picking/print', createElement(PickingPrintView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-237-print',
  title: 'Pick lists (print): one walk by bin path for many work orders',
  view: PrintDesign,
  cases: [
    { id: 'two', label: 'Two work orders: the walk by bin path, then each work order', model: { role: 'warehouse', page: printModel() } },
    { id: 'reading', label: 'Reading', model: { role: 'warehouse', page: printModel({ sheets: { value: null, problem: null }, readAt: null }) } },
    { id: 'error', label: "Couldn't be read", model: { role: 'warehouse', page: printModel({ sheets: { value: null, problem: 'problem.offline' }, readAt: null }) } },
    { id: 'none', label: 'No work order asked', model: { role: 'warehouse', page: printModel({ ids: [], sheets: { value: [], problem: null } }) } },
    { id: 'sales', label: 'Sales: no inventory.stock.view', model: { role: 'sales', page: printModel({ allowed: false }) } },
  ],
})
