'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'
import { SupplierOrderPage } from '../../../../../../portal/supplier/orders/OrderPage'

/**
 * `/p/<party code>/orders/<id>?tab=…` — one order: a supplier's purchase order (B-W2b-179); a customer's order is B-W2b-191's
 * (the same address, picked here by the person's kind — plan §12, a merge point).
 */
export default function PortalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  // B-W2b-179: the supplier's purchase order.
  if (kinds.includes('SUPPLIER')) return <SupplierOrderPage id={id} />
  return <NotInAccessHere />
}
