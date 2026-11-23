'use client'

import { useMemo, type ReactNode } from 'react'
import type { UnreadMap } from '../../../../lib/last-message-cell/model'
import { LAST_MESSAGE_NS } from '../../../../lib/last-message-cell/view/LastMessageCell'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type ListDepth, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'
import { useT } from '../../../../lib/i18n/provider'
import { customerBarActs, customerRowItems, useCustomerColumns } from '../list/columns'
import { CUSTOMERS_LIST_NS, type CustomerRights } from '../list/model'
import { useOverdueColumns, type OverdueListModel } from '../money/columns'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'

/**
 * SCR-032 Customers (design sales.customers): the parties list seen from Sales — the roles we sell to (Customer, Brand). The
 * list is the shared one (areas/parties/_shared): Suppliers draws the same parts from the buying side. The band's Import
 * (B-W2a-49, design pop:customers.import) comes in as `headActions`: the container mounts it. B-W2a-81: the Overdue column
 * (price grain, receivables.view) from `overdue`, the one read of who owes late. F-CL-102: the customers' own parts (the
 * Customer cell, New messages from `unread`, the identity columns hidden at first, the phone card) — drawn from what it is given.
 * F-CL-104: the bar's own acts and the row's doors for the `rights` given (the windows are the container's: no-op here).
 */
export function CustomersView({ model, actions, headActions, overdue, unread, rights }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel; unread?: UnreadMap | null; rights?: CustomerRights }) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE, CUSTOMERS_LIST_NS, LAST_MESSAGE_NS]}>
      <Customers model={model} actions={actions} headActions={headActions} overdue={overdue} unread={unread ?? null} rights={rights ?? NO_RIGHTS} />
    </WithMessages>
  )
}

/** A reader with none of the customers' own rights (no bar act, no door of theirs). */
const NO_RIGHTS: CustomerRights = { threads: false, orders: false, tasks: false, supervisor: false }
const nothing = () => undefined

function Customers({ model, actions, headActions, overdue, unread, rights }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel | undefined; unread: UnreadMap | null; rights: CustomerRights }) {
  const c = useT(CUSTOMERS_LIST_NS)
  const overdueColumns = useOverdueColumns(overdue ?? null)
  const columns = useCustomerColumns({ prefix: model.prefix, unread, overdue: overdueColumns })
  const ticked = useMemo(() => (model.rows.items ?? []).filter((row) => model.selected.includes(row.id)), [model.rows.items, model.selected])
  const depth = useMemo<ListDepth>(
    () => ({
      nameColumn: columns.nameColumn,
      leadingColumns: columns.leadingColumns,
      hiddenColumns: columns.hiddenColumns,
      card: columns.card,
      rowItems: (row) => customerRowItems(rights, model.prefix, row, c, nothing),
      acts: customerBarActs(rights, ticked, c, { onTask: nothing, onSupervisor: nothing }),
    }),
    [columns, rights, model.prefix, c, ticked],
  )
  return <PartiesListView model={{ ...model, side: 'customers' }} actions={actions} headActions={headActions} depth={depth} />
}
