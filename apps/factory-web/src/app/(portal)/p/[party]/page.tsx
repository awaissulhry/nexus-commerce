'use client'

import { PortalHome } from '../../../../portal/shell/home/PortalHome'
import { usePortalFrame } from '../../../../portal/shell/frame'
import { SupplierHome } from '../../../../portal/supplier/home/SupplierHome'
import { CustomerHome } from '../../../../portal/customer/home/CustomerHome'

/**
 * `/p/<party code>` — Home. One thin route file picks the page by the person's kind (plan §12, a merge point of the Home
 * steps B-W2b-187 customer and B-W2b-179 supplier): a supplier or a workshop gets its Home (B-W2b-179), a customer its
 * Home (B-W2b-187); everyone else (an adviser's portal), the frame's own Home: what waits for you.
 */
export default function PortalHomePage() {
  const { kinds } = usePortalFrame()
  // B-W2b-179: the supplier's and the workshop's Home.
  if (!kinds.includes('CUSTOMER') && (kinds.includes('SUPPLIER') || kinds.includes('SUBCONTRACTOR'))) return <SupplierHome />
  // B-W2b-187: the customer's Home.
  if (kinds.includes('CUSTOMER')) return <CustomerHome />
  return <PortalHome />
}
