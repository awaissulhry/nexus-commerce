'use client'

import { useMemo, useState } from 'react'
import { readUnreadWith } from '../../../../lib/last-message-cell/api'
import { useUnread } from '../../../../lib/last-message-cell/use-unread'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import type { ListDepthArgs, ListDepthSlot } from '../../../parties/_shared/PartiesList'
import type { ListDepth } from '../../../parties/_shared/view/PartiesListView'
import { useOverdueColumns } from '../money/columns'
import { useOverdueList } from '../money/hooks'
import { useCustomerColumns } from './columns'
import { customerRightsOf } from './model'

/**
 * F-CL-102 (customers list plan §1, 13-backend §8.1 / §8.6): the customers' own parts of the shared list, with their reads — each
 * fires only when shown and never per row: New messages = ONE `POST /threads/unread` per loaded page of customers (threads.read;
 * read again, coalesced, on a live `thread.*` change), Overdue = the one read of who owes late (cu/money). The slot it gives the
 * list is called once per render of the list, at one place (PartiesList.tsx), so its hooks keep their order.
 */
export function useCustomersDepth(): ListDepthSlot {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const rights = useMemo(() => customerRightsOf(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const overdue = useOverdueColumns(useOverdueList())
  const [tick, setTick] = useState(0)
  useLiveBus({ onChange: (change) => change.type.startsWith('thread.') && setTick((count) => count + 1), onReconnect: () => setTick((count) => count + 1) }, rights.threads)
  const readUnread = useMemo(() => (rights.threads ? readUnreadWith(api) : null), [api, rights.threads])

  return function useCustomersSlot(list: ListDepthArgs): ListDepth {
    const asked = useMemo(() => list.rows.map((row) => ({ recordType: 'Party', id: row.id })), [list.rows])
    const unread = useUnread(readUnread, asked, tick)
    const columns = useCustomerColumns({ prefix, unread: rights.threads ? unread : null, overdue })
    return { nameColumn: columns.nameColumn, leadingColumns: columns.leadingColumns, hiddenColumns: columns.hiddenColumns, card: columns.card }
  }
}
