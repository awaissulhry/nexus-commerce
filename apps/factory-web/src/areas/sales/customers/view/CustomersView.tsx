'use client'

import type { ReactNode } from 'react'
import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'

/**
 * SCR-032 Customers (design sales.customers): the parties list seen from Sales — the roles we sell to (Customer,
 * Brand), the tiles for who has no valid VIES check and who cannot be invoiced yet, the SDI code or PEC column. The list
 * is the shared one (areas/parties/_shared): Suppliers draws the same parts from the buying side. The band's Import
 * (B-W2a-49, design pop:customers.import) comes in as `headActions`: the container mounts it.
 */
export function CustomersView({ model, actions, headActions }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode }) {
  return <PartiesListView model={{ ...model, side: 'customers' }} actions={actions} headActions={headActions} />
}
