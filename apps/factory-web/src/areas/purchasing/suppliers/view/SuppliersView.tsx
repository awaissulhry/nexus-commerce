'use client'

import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'

/**
 * SCR-056 Suppliers (design purchasing.suppliers): the parties list seen from Purchasing — the roles we buy from or
 * send work and goods with (Supplier, Subcontractor, Carrier), the VAT number with its VIES mark. The list is the shared
 * one (areas/parties/_shared): Customers draws the same parts from the selling side.
 */
export function SuppliersView({ model, actions }: { model: PartiesListModel; actions?: PartiesListActions }) {
  return <PartiesListView model={{ ...model, side: 'suppliers' }} actions={actions} />
}
