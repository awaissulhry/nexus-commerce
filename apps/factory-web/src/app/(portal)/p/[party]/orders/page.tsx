'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'
import { SupplierOrdersPage } from '../../../../../portal/supplier/orders/OrdersPage'
import { CustomerOrdersPage } from '../../../../../portal/customer/orders/OrdersPage'

/**
 * `/p/<party code>/orders` — a customer's Orders & tracking (B-W2b-191) and a supplier's Purchase orders (B-W2b-179) share the
 * address: one thin route file picks the page by the person's kind (plan §12, a merge point). Until a kind's page is built, a
 * typed address says it is not part of the person's access.
 */
export default function PortalOrdersPage() {
  const { kinds } = usePortalFrame()
  // B-W2b-179: the supplier's purchase orders.
  if (kinds.includes('SUPPLIER')) return <SupplierOrdersPage />
  // B-W2b-191: the customer's Orders & tracking.
  if (kinds.includes('CUSTOMER')) return <CustomerOrdersPage />
  return <NotInAccessHere />
}
