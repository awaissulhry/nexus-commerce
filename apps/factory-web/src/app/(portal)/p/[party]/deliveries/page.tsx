'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { SupplierDeliveriesPage } from '../../../../../portal/supplier/deliveries/DeliveriesPage'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/deliveries?state=&q=` — a supplier's Ship notices (B-W2b-186, SCR-227; design portal.supplier.asn): the
 * deliveries announced and how each was received. Another kind of partner reads that it is not part of its access.
 */
export default function PortalDeliveriesPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUPPLIER')) return <SupplierDeliveriesPage />
  return <NotInAccessHere />
}
