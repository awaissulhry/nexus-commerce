'use client'

import { useMemo, type ReactNode } from 'react'
import type { UnreadMap } from '../../../../lib/last-message-cell/model'
import { LAST_MESSAGE_NS } from '../../../../lib/last-message-cell/view/LastMessageCell'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PartyWorkBand } from '../../../parties/_shared/api'
import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type ListDepth, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'
import { useT } from '../../../../lib/i18n/provider'
import { customerBarActs, customerRowItems, useCustomerColumns } from '../list/columns'
import { CUSTOMERS_LIST_NS, WORK_WORDS, type CustomerRights, type CustomersWorkModel } from '../list/model'
import { bandHintOf, CustomersBand, groupName } from '../list/view/CustomersBand'
import { useOverdueColumns, type OverdueListModel } from '../money/columns'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'

/**
 * SCR-032 Customers (design sales.customers): the parties list seen from Sales — the roles we sell to (Customer, Brand). The
 * list is the shared one (areas/parties/_shared): Suppliers draws the same parts from the buying side. The band's Import
 * (B-W2a-49, design pop:customers.import) comes in as `headActions`: the container mounts it. B-W2a-81: the Overdue column
 * (price grain, receivables.view) from `overdue`, the one read of who owes late. F-CL-102: the customers' own parts (the
 * Customer cell, New messages from `unread`, the identity columns hidden at first, the phone card) — drawn from what it is given.
 * F-CL-104: the bar's own acts and the row's doors for the `rights` given (the windows are the container's: no-op here).
 * F-CL-202: with `work` (orders.view) the band in the head row, the picture, Needs us, Work, Next promise and Last order.
 */
export interface CustomersViewWork {
  /** Each customer's work facts (orders.view); absent: the row as without orders.view. */
  readonly facts: CustomersWorkModel
  /** The band's read. */
  readonly band: { readonly band: PartyWorkBand | null; readonly problem: string | null }
  /** Today in the site's zone (YYYY-MM-DD). */
  readonly today: string
  /** The list room is wide (1920). */
  readonly wide?: boolean
}

export function CustomersView({ model, actions, headActions, overdue, unread, rights, work }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel; unread?: UnreadMap | null; rights?: CustomerRights; work?: CustomersViewWork | null }) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE, CUSTOMERS_LIST_NS, LAST_MESSAGE_NS, ...WORK_WORDS]}>
      <Customers model={model} actions={actions} headActions={headActions} overdue={overdue} unread={unread ?? null} rights={rights ?? NO_RIGHTS} work={work ?? null} />
    </WithMessages>
  )
}

/** A reader with none of the customers' own rights (no bar act, no door of theirs). */
const NO_RIGHTS: CustomerRights = { threads: false, orders: false, tasks: false, supervisor: false }
const nothing = () => undefined

function Customers({ model, actions, headActions, overdue, unread, rights, work }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; overdue?: OverdueListModel | undefined; unread: UnreadMap | null; rights: CustomerRights; work: CustomersViewWork | null }) {
  const c = useT(CUSTOMERS_LIST_NS)
  const p = useT('parties')
  const ord = useT('orders')
  const sheet = useT('orders-sheet')
  const overdueColumns = useOverdueColumns(overdue ?? null)
  const columns = useCustomerColumns({ prefix: model.prefix, unread, overdue: overdueColumns, work: work?.facts ?? null, ...(work ? { today: work.today, wide: work.wide === true } : {}) })
  const ticked = useMemo(() => (model.rows.items ?? []).filter((row) => model.selected.includes(row.id)), [model.rows.items, model.selected])
  const bandWords = useMemo(() => ({ c, ord, sheet, p }), [c, ord, sheet, p])
  const pressed = model.work ?? null
  const depth = useMemo<ListDepth>(
    () => ({
      beforeName: columns.beforeName,
      nameColumn: columns.nameColumn,
      leadingColumns: columns.leadingColumns,
      hiddenColumns: columns.hiddenColumns,
      card: columns.card,
      rowItems: (row) => customerRowItems(rights, model.prefix, row, c, nothing),
      acts: customerBarActs(rights, ticked, c, { onTask: nothing, onSupervisor: nothing }),
      ...(work ? { band: <CustomersBand band={work.band.band} problem={work.band.problem} work={pressed} onWork={(group) => actions?.onWork?.(group)} wide={work.wide === true} about={p('customers.intro')} words={bandWords} /> } : {}),
      workChip: pressed ? { label: groupName(pressed, bandWords), ...(work?.band.band ? { hint: bandHintOf(pressed, work.band.band, bandWords) } : {}), empty: pressed === 'NEEDS_US' ? c('empty.needs') : c('empty.work', { group: groupName(pressed, bandWords) }) } : null,
      exportAbout: { heading: c('export.heading'), note: c('export.note') },
    }),
    [columns, rights, model.prefix, c, p, ticked, work, pressed, bandWords, actions],
  )
  return <PartiesListView model={{ ...model, side: 'customers' }} actions={actions} headActions={headActions} depth={depth} />
}
