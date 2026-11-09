'use client'

import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { CustomerNewOrderPage } from '../../../../../../portal/customer/neworder/NewOrderPage'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/orders/new?draft=<id>&way=pick|reorder|upload&styles=&reorder=&line=` — a customer's New order & reorder
 * (B-W2b-194, SCR-185; design portal.customer.neworder): three ways in, one draft kept on the server. A supplier's
 * `/orders/new` is not a page of theirs (their `/orders/<id>` is a purchase order).
 */
export default function PortalNewOrderPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerNewOrderPage />
  return <NotInAccessHere />
}
