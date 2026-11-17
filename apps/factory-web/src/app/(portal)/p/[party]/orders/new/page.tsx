'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { CustomerRequestPage } from '../../../../../../portal/customer/neworder/ComposePage'
import { CustomerNewOrderPage } from '../../../../../../portal/customer/neworder/NewOrderPage'
import { opensCatalogueDoor } from '../../../../../../portal/customer/neworder/request-model'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/orders/new` — a customer's New order (B-TH-220, SCR-185): the request written like an e-mail. The catalogue
 * door (B-W2b-194's draft with lines: `?draft=&way=&reorder=`) opens its page only while it is open — closed until catalogue
 * orders land in Sales › Incoming (B-TH-304, PR-18). A supplier's `/orders/new` is not a page of theirs (their
 * `/orders/<id>` is a purchase order).
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
  return opensCatalogueDoor(search) ? <CustomerNewOrderPage /> : <CustomerRequestPage />
}
