import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OfficeNewOrderRoute } from '../../../../../../../areas/sales/orders/draft/OfficeNewOrderRoute'

export const metadata: Metadata = { title: 'New order · Nexus Factory' }

/** od-w2.1: `?party=` the typed catalogue order (unchanged); else the ONE draft order — `?draft=<id>`, or the start. */
export default function SalesNewOrderPage() {
  return (
    <Suspense>
      <OfficeNewOrderRoute />
    </Suspense>
  )
}
