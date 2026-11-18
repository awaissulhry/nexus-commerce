'use client'

import { WithMessages } from '../../../../record-panels/i18n'
import { NAMESPACE as DEPTH } from '../depth/model'
import { NAMESPACE as SHEET } from './sheet/model'
import { useOrdersSheet } from './use-orders-sheet'
import { OrdersListView } from './view/OrdersListView'

/**
 * `/w/<company>/sales/orders` (SCR-038): the ONE Orders sheet (use-orders-sheet.ts, F-SA-220: its reads, its address, its live
 * changes, New order) on its own page — every term its own, its own band and tiles, a row opens its order.
 */
export function OrdersPage() {
  return (
    <WithMessages namespaces={['orders', 'lists', DEPTH /* B-W2b-323 */, SHEET /* B-TH-225 */]}>
      <OrdersContainer />
    </WithMessages>
  )
}

function OrdersContainer() {
  const { model, actions } = useOrdersSheet({ basePath: '/sales/orders' })
  return <OrdersListView model={model} actions={actions} />
}
