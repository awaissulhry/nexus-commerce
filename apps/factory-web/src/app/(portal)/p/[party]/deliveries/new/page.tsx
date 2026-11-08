'use client'

import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { SupplierNoticePage } from '../../../../../../portal/supplier/deliveries/NoticePage'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/deliveries/new?po=<id>` — announce a delivery from one of our confirmed orders (B-W2b-186; design
 * portal.supplier.asn sub-page `announce`). Without `po`: the orders with lines to ship.
 */
export default function PortalAnnouncePage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUPPLIER')) return <SupplierNoticePage id={null} />
  return <NotInAccessHere />
}
