'use client'

import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'

/**
 * SCR-032 Customers (design sales.customers): the parties list seen from Sales — the roles we sell to (Customer,
 * Brand), the tiles for who has no valid VIES check and who cannot be invoiced yet, the SDI code or PEC column. The list
 * is the shared one (areas/parties/_shared): Suppliers draws the same parts from the buying side.
 */
export function CustomersView({ model, actions }: { model: PartiesListModel; actions?: PartiesListActions }) {
  return <PartiesListView model={{ ...model, side: 'customers' }} actions={actions} />
}
