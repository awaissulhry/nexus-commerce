'use client'

import { useSearchParams } from 'next/navigation'
import { WithMessages } from '../../../../record-panels/i18n'
import { NAMESPACE as DEPTH } from '../depth/model'
import { layoutFromAddress } from '../model'
import { NAMESPACE as SHEET } from './sheet/model'
import { OfficeSheetPage } from './office-sheet/OfficeSheetPage'
import { useOrdersSheet } from './use-orders-sheet'
import { OrdersListView } from './view/OrdersListView'

/** `/w/<company>/sales/orders` (SCR-038). owb-of3: the Sheet = the ONE orders sheet part on of1's read (office-sheet/); the Board
 *  and By promise week (`?view=board|week`) stay today's views and reads (use-orders-sheet.ts), live "N updates · Show" as they were. */
export function OrdersPage() {
  const params = useSearchParams()
  if (layoutFromAddress(params) === 'list') return <OfficeSheetPage />
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
