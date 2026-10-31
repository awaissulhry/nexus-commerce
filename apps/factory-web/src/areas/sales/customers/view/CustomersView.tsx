'use client'

import type { ReactNode } from 'react'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'
import { useOverdueColumns, type OverdueListModel } from '../money/columns'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'

/**
 * SCR-032 Customers (design sales.customers): the parties list seen from Sales — the roles we sell to (Customer,
 * Brand), the tiles for who has no valid VIES check and who cannot be invoiced yet, the SDI code or PEC column. The list
 * is the shared one (areas/parties/_shared): Suppliers draws the same parts from the buying side. The band's Import
 * (B-W2a-49, design pop:customers.import) comes in as `headActions`: the container mounts it. B-W2a-81: the Overdue
 * column (price grain, receivables.view) from `overdue`, the one read of who owes late.
 */
export function CustomersView({ model, actions, headActions, overdue }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel }) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customers model={model} actions={actions} headActions={headActions} overdue={overdue} />
    </WithMessages>
  )
}

function Customers({ model, actions, headActions, overdue }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel }) {
  const columns = useOverdueColumns(overdue ?? null)
  return <PartiesListView model={{ ...model, side: 'customers' }} actions={actions} headActions={headActions} columns={columns} />
}
