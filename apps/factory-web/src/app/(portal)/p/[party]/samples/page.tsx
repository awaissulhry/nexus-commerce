'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'
import { CustomerSamplesRoute } from '../../../../../portal/customer/samples/SamplesPage'

/**
 * `/p/<party code>/samples?style=&decide=` — the brand's Samples & tech packs (B-W2b-262, SCR-225; design
 * portal.customer.samples). A customer's page only: a supplier, a workshop or a guest is told it is not part of their access.
 */
export default function PortalSamplesPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerSamplesRoute />
  return <NotInAccessHere />
}
