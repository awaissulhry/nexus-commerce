'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'
import { CustomerProductionPage } from '../../../../../portal/customer/production/ProductionPage'

/**
 * `/p/<party code>/production?chip=&q=` — the customer's My production (F-PR-11; production plan §5, 06-tree B.1): its orders in
 * production in its own order, Urgent and Regular, with its urgency marks. A customer's page only: a supplier, a workshop or a
 * guest is told it is not part of their access; a customer role without the page reads the same.
 */
export default function PortalProductionPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerProductionPage />
  return <NotInAccessHere />
}
