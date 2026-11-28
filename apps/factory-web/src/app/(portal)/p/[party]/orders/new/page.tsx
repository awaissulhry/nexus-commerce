'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { CustomerRequestPage } from '../../../../../../portal/customer/neworder/ComposePage'
import { CustomerNewOrderPage } from '../../../../../../portal/customer/neworder/NewOrderPage'
import { CustomerOrdersPage } from '../../../../../../portal/customer/orders/OrdersPage'
import { newOrderDoorOf } from '../../../../../../portal/customer/neworder/request-model'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/orders/new` — a customer's New order (B-TH-220, SCR-185). F-CP-152 (customer page plan C5, 12 §2 Doors): for
 * who keeps drafts (portal.orderDrafts.edit) it opens the draft order's start — Pick styles, Reorder a past order, Upload a sheet,
 * the drafts to continue — and "Just write it in words" leads to the request written like an e-mail (`?way=words`), which is
 * also the page of who may order but keeps no drafts. A draft, a way, a style or a past order in the address opens the draft
 * order (B-W2b-194; open again since catalogue orders land in Sales › Incoming, B-TH-304). A supplier's `/orders/new` is not a
 * page of theirs (their `/orders/<id>` is a purchase order).
 * owb-po3.1 (design § 5zi D): the draft order is the New order WINDOW over the orders page (`?draft=<id>` keeps its deep link; closing
 * it returns to `/orders`). The orders sheet (po7) and the order band (web B) open the same window by this address.
 */
export default function PortalNewOrderPage() {
  const { kinds } = usePortalFrame()
  if (!kinds.includes('CUSTOMER')) return <NotInAccessHere />
  return (
    <Suspense fallback={null}>
      <CustomerNewOrder />
    </Suspense>
  )
}

function CustomerNewOrder() {
  const search = useSearchParams()
  const { me } = usePortalFrame()
  // F-CP-152: the draft order for who keeps drafts; the request like an e-mail for `way=words` and for anyone else.
  return newOrderDoorOf(search, { mayDraft: me.permissions.includes('portal.orderDrafts.edit') }) === 'draft' ? (
    <>
      <CustomerOrdersPage />
      <CustomerNewOrderPage />
    </>
  ) : (
    <CustomerRequestPage />
  )
}
